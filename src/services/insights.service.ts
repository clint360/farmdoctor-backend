import { GoogleGenAI } from "@google/genai";
import { supabase } from "./db/supabase.service";
import { logger } from "../utils/logger";

// ─── Gemini client (reuse same pattern as gemini.service.ts) ────────────────
const getTextModel = () => process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (!_client) {
    const vertexProject = process.env.VERTEX_PROJECT_ID;
    const vertexLocation = process.env.VERTEX_LOCATION || "us-central1";
    if (vertexProject) {
      _client = new GoogleGenAI({ vertexai: true, project: vertexProject, location: vertexLocation });
    } else {
      _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });
    }
  }
  return _client;
}

// ─── Types ──────────────────────────────────────────────────────────────────
export type CropReportRow = {
  id: string;
  crop_type: string | null;
  diagnosis: string | null;
  treatment: string | null;
  confidence: number | null;
  location: string | null;
  created_at: string;
};

export type WeatherDay = {
  date: string;
  tempMax: number;
  tempMin: number;
  precipitationMm: number;
  humidityMaxPct: number;
};

export type WeatherContext = {
  resolvedName: string;
  latitude: number;
  longitude: number;
  current: {
    temperatureC: number;
    humidityPct: number;
    precipitationMm: number;
  };
  forecast: WeatherDay[];           // 7-day daily forecast
  weekSummary: {
    totalPrecipitationMm: number;
    avgTempMaxC: number;
    avgHumidityMaxPct: number;
  };
};

export type InsightsResult = {
  crop: string;
  location: string | null;
  isValidCrop: boolean;
  adviceSummary: string;
  stepsToPlant: string[];
  stepsToMaintain: string[];
  riskAlerts: string[];
  weatherConsiderations: string;
  communitySignals: string;
  weather: WeatherContext | null;
  reportCount: number;
  generatedAt: string;
};

export type SuggestionsResult = {
  suggestions: string[];
};

// ─── Weather: geocode + forecast (Open-Meteo, no API key required) ───────────
const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

async function geocodeLocation(location: string): Promise<{ name: string; lat: number; lon: number } | null> {
  try {
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = await res.json() as { results?: Array<{ name: string; latitude: number; longitude: number }> };
    const hit = json.results?.[0];
    if (!hit) return null;
    return { name: hit.name, lat: hit.latitude, lon: hit.longitude };
  } catch (err) {
    logger.warn({ err }, "[insights] geocodeLocation failed");
    return null;
  }
}

async function fetchWeather(location: string): Promise<WeatherContext | null> {
  const geo = await geocodeLocation(location);
  if (!geo) return null;

  try {
    const params = new URLSearchParams({
      latitude: String(geo.lat),
      longitude: String(geo.lon),
      current: "temperature_2m,relative_humidity_2m,precipitation",
      daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,relative_humidity_2m_max",
      timezone: "auto",
      forecast_days: "7",
    });
    const res = await fetch(`${FORECAST_URL}?${params}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;

    const json = await res.json() as {
      current: { temperature_2m: number; relative_humidity_2m: number; precipitation: number };
      daily: {
        time: string[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        precipitation_sum: number[];
        relative_humidity_2m_max: number[];
      };
    };

    const forecast: WeatherDay[] = (json.daily.time ?? []).map((date, i) => ({
      date,
      tempMax: json.daily.temperature_2m_max[i] ?? 0,
      tempMin: json.daily.temperature_2m_min[i] ?? 0,
      precipitationMm: json.daily.precipitation_sum[i] ?? 0,
      humidityMaxPct: json.daily.relative_humidity_2m_max[i] ?? 0,
    }));

    const totalPrecip = forecast.reduce((s, d) => s + d.precipitationMm, 0);
    const avgTempMax = forecast.reduce((s, d) => s + d.tempMax, 0) / (forecast.length || 1);
    const avgHumMax = forecast.reduce((s, d) => s + d.humidityMaxPct, 0) / (forecast.length || 1);

    return {
      resolvedName: geo.name,
      latitude: geo.lat,
      longitude: geo.lon,
      current: {
        temperatureC: json.current.temperature_2m,
        humidityPct: json.current.relative_humidity_2m,
        precipitationMm: json.current.precipitation,
      },
      forecast,
      weekSummary: {
        totalPrecipitationMm: Math.round(totalPrecip * 10) / 10,
        avgTempMaxC: Math.round(avgTempMax * 10) / 10,
        avgHumidityMaxPct: Math.round(avgHumMax),
      },
    };
  } catch (err) {
    logger.warn({ err }, "[insights] fetchWeather forecast failed");
    return null;
  }
}

function formatWeatherForPrompt(weather: WeatherContext): string {
  const { current, weekSummary, forecast, resolvedName } = weather;
  const lines = [
    `LIVE WEATHER DATA for ${resolvedName} (fetched from Open-Meteo):`,
    `Current conditions: ${current.temperatureC}°C, humidity ${current.humidityPct}%, precipitation today ${current.precipitationMm}mm`,
    `7-day outlook: total rainfall ${weekSummary.totalPrecipitationMm}mm, avg max temp ${weekSummary.avgTempMaxC}°C, avg max humidity ${weekSummary.avgHumidityMaxPct}%`,
    `Daily forecast:`,
    ...forecast.map(d =>
      `  ${d.date}: ${d.tempMin}–${d.tempMax}°C, rain ${d.precipitationMm}mm, humidity up to ${d.humidityMaxPct}%`
    ),
  ];
  return lines.join("\n");
}

// ─── Fetch matching crop reports ─────────────────────────────────────────────
async function fetchCropReports(crop: string, location?: string): Promise<CropReportRow[]> {
  const cropNorm = crop.toLowerCase().trim();

  let query = supabase
    .from("crop_reports")
    .select("id, crop_type, diagnosis, treatment, confidence, location, created_at")
    .not("crop_type", "is", null)
    .order("created_at", { ascending: false })
    .limit(50);

  // Supabase ilike filter for crop type
  query = query.ilike("crop_type", `%${cropNorm}%`);

  if (location) {
    const locNorm = location.toLowerCase().trim();
    query = query.ilike("location", `%${locNorm}%`);
  }

  const { data, error } = await query;
  if (error) {
    logger.error(error, "[insights] fetchCropReports error");
    return [];
  }
  return (data ?? []) as CropReportRow[];
}

// ─── Build community signal summary from reports ─────────────────────────────
function buildCommunityContext(reports: CropReportRow[]): string {
  if (reports.length === 0) return "No recent farmer reports found for this crop.";

  const recentReports = reports.slice(0, 20);

  // Tally diagnoses
  const diagnosisCounts: Record<string, number> = {};
  for (const r of recentReports) {
    if (r.diagnosis) {
      const d = r.diagnosis.trim();
      diagnosisCounts[d] = (diagnosisCounts[d] ?? 0) + 1;
    }
  }

  // Top locations
  const locationCounts: Record<string, number> = {};
  for (const r of recentReports) {
    if (r.location) {
      const l = r.location.trim();
      locationCounts[l] = (locationCounts[l] ?? 0) + 1;
    }
  }

  const topDiagnoses = Object.entries(diagnosisCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([d, c]) => `"${d}" (${c} report${c > 1 ? "s" : ""})`)
    .join(", ");

  const topLocations = Object.entries(locationCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([l, c]) => `${l} (${c})`)
    .join(", ");

  const lines: string[] = [
    `Total recent reports: ${reports.length}`,
    topDiagnoses ? `Most reported issues: ${topDiagnoses}` : "",
    topLocations ? `Active farming locations: ${topLocations}` : "",
  ];

  // Include a few sample report summaries for Gemini context
  const samples = recentReports
    .filter((r) => r.diagnosis || r.treatment)
    .slice(0, 8)
    .map((r) => {
      const parts: string[] = [];
      if (r.location) parts.push(`Location: ${r.location}`);
      if (r.diagnosis) parts.push(`Issue: ${r.diagnosis}`);
      if (r.treatment) parts.push(`Treatment: ${r.treatment}`);
      if (r.confidence != null) parts.push(`Confidence: ${Math.round(r.confidence * 100)}%`);
      return parts.join(" | ");
    });

  if (samples.length > 0) {
    lines.push("", "Recent farmer report samples:", ...samples.map((s) => `- ${s}`));
  }

  return lines.filter(Boolean).join("\n");
}

// ─── Insights prompt ─────────────────────────────────────────────────────────
const INSIGHTS_SYSTEM = `You are Farm Doctor Insights — an agricultural intelligence engine for Central/West African farmers.
Your role is to generate structured, practical farming guidance based on real farmer report data and your agricultural expertise.
Always produce region-aware, localised advice. Prioritise crops and conditions relevant to Cameroon and Central Africa.
Be practical: reference locally available products, realistic planting calendars, and actual environmental conditions.
Never invent products or techniques unavailable in the region.`;

function buildInsightsPrompt(
  crop: string,
  location: string | null,
  communityContext: string,
  locale: string | null,
  weather: WeatherContext | null
): string {
  const regionText = location
    ? `Target region: ${location}, Cameroon / Central Africa.`
    : "No specific location provided. Use region-neutral Central Africa guidance.";

  const langNote =
    locale === "fr"
      ? "IMPORTANT: Write all section content in French."
      : locale === "pid"
      ? "IMPORTANT: Write all section content in simple English (Cameroon audience)."
      : "Write all section content in English.";

  const weatherBlock = weather
    ? `\n${formatWeatherForPrompt(weather)}\nUse the live data above (not generic assumptions) for the weatherConsiderations section.`
    : "\nNo live weather data available. Use your knowledge of regional climate patterns for weatherConsiderations.";

  return `${INSIGHTS_SYSTEM}

${regionText}
Crop requested: "${crop}"
${langNote}
${weatherBlock}

Community intelligence from farmer reports (Supabase crop_reports table):
${communityContext}

First, determine whether the query is a real crop, plant, or agricultural subject.
Return ONLY a valid JSON object (no markdown, no code fences) with this exact structure:

{
  "isValidCrop": true,
  "adviceSummary": "2-3 sentence overview: is this crop suitable for the given location and current season? Overall outlook.",
  "stepsToPlant": [
    "Step 1: ...",
    "Step 2: ...",
    "Step 3: ..."
  ],
  "stepsToMaintain": [
    "Step 1: ...",
    "Step 2: ..."
  ],
  "riskAlerts": [
    "Risk 1: ...",
    "Risk 2: ..."
  ],
  "weatherConsiderations": "Paragraph grounded in the live forecast data: interpret current temperature, this week's rainfall total, and humidity levels in terms of what they mean for growing ${crop} right now.",
  "communitySignals": "Short paragraph summarising what the farmer report data above reveals — current issues, active regions, treatment trends. If no data, say there are no recent community reports for this crop."
}

Rules:
- Set "isValidCrop" to false if the query is clearly not a crop, plant, or agricultural topic (e.g. "iPhone", "football", "car", "movie", "bitcoin", random words). If false, set adviceSummary to a short friendly note and leave all arrays empty and weatherConsiderations/communitySignals as empty strings.
- stepsToPlant must include land prep, spacing, watering, and early protection (minimum 4 steps)
- stepsToMaintain must include fertilisation timing, pest prevention, irrigation, and disease monitoring (minimum 4 steps)
- riskAlerts must include at least 3 specific threats based on location and community data
- weatherConsiderations must cite actual numbers from the live forecast (temperatures, mm of rain, humidity %) when available
- communitySignals must directly reference the farmer report data provided
- Return ONLY the JSON object, nothing else`;
}

// ─── Main search function ────────────────────────────────────────────────────
export async function searchInsights(
  crop: string,
  location?: string,
  locale?: string
): Promise<InsightsResult> {
  const [reports, weather] = await Promise.all([
    fetchCropReports(crop, location),
    location ? fetchWeather(location) : Promise.resolve(null),
  ]);

  const communityContext = buildCommunityContext(reports);
  const prompt = buildInsightsPrompt(crop, location ?? null, communityContext, locale ?? null, weather);

  const result = await client().models.generateContent({
    model: getTextModel(),
    contents: [{ role: "user", parts: [{ text: prompt }] }],
  });

  const raw = (result.text ?? "").trim();
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  let parsed: Partial<InsightsResult> = {};
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    logger.error(err, "[insights] Gemini JSON parse failed, raw: " + raw.slice(0, 300));
    // Return a safe fallback
    parsed = {
      adviceSummary: cleaned.slice(0, 500),
      stepsToPlant: [],
      stepsToMaintain: [],
      riskAlerts: [],
      weatherConsiderations: "",
      communitySignals: communityContext,
    };
  }

  const isValidCrop = (parsed as any).isValidCrop !== false;

  return {
    crop,
    location: location ?? null,
    isValidCrop,
    adviceSummary: (parsed as any).adviceSummary ?? "",
    stepsToPlant: Array.isArray((parsed as any).stepsToPlant) ? (parsed as any).stepsToPlant : [],
    stepsToMaintain: Array.isArray((parsed as any).stepsToMaintain) ? (parsed as any).stepsToMaintain : [],
    riskAlerts: Array.isArray((parsed as any).riskAlerts) ? (parsed as any).riskAlerts : [],
    weatherConsiderations: (parsed as any).weatherConsiderations ?? "",
    communitySignals: (parsed as any).communitySignals ?? communityContext,
    weather,
    reportCount: reports.length,
    generatedAt: new Date().toISOString(),
  };
}

// ─── Suggestions ─────────────────────────────────────────────────────────────
const MIN_DB_SUGGESTIONS = 6;

async function fetchDbSuggestions(q: string): Promise<string[]> {
  const qLower = q.toLowerCase().trim();

  const [cropRes, locRes] = await Promise.all([
    supabase
      .from("crop_reports")
      .select("crop_type")
      .not("crop_type", "is", null)
      .ilike("crop_type", `%${qLower}%`)
      .limit(20),
    supabase
      .from("crop_reports")
      .select("location")
      .not("location", "is", null)
      .ilike("location", `%${qLower}%`)
      .limit(20),
  ]);

  // Distinct crop types
  const crops: string[] = [];
  const seenCrops = new Set<string>();
  for (const row of (cropRes.data ?? []) as Array<{ crop_type: string | null }>) {
    if (row.crop_type && !seenCrops.has(row.crop_type.toLowerCase())) {
      seenCrops.add(row.crop_type.toLowerCase());
      crops.push(row.crop_type.toLowerCase());
    }
  }

  // Distinct locations
  const locations: string[] = [];
  const seenLocs = new Set<string>();
  for (const row of (locRes.data ?? []) as Array<{ location: string | null }>) {
    if (row.location && !seenLocs.has(row.location.toLowerCase())) {
      seenLocs.add(row.location.toLowerCase());
      locations.push(row.location.toLowerCase());
    }
  }

  // Combine: crop suggestions + "crop location" combos
  const suggestions: string[] = [...crops];
  for (const crop of crops.slice(0, 5)) {
    for (const loc of locations.slice(0, 3)) {
      suggestions.push(`${crop} ${loc}`);
    }
  }
  suggestions.push(...locations.map((l) => `crops ${l}`));

  return [...new Set(suggestions)].slice(0, 12);
}

async function fetchGeminiSuggestions(q: string): Promise<string[]> {
  const prompt = `You are an agricultural search assistant for Farm Doctor, a platform serving farmers in Cameroon and Central Africa.

The user typed: "${q}"

Generate 8 search-friendly crop and location query suggestions that farmers in Cameroon would find useful.
Format them as short queries like:
- cassava yaounde
- maize west region
- tomatoes rainy season cameroon
- cocoa southwest region

Return ONLY a valid JSON array of strings (no markdown, no code fences):
["suggestion1","suggestion2","suggestion3","suggestion4","suggestion5","suggestion6","suggestion7","suggestion8"]`;

  try {
    const result = await client().models.generateContent({
      model: getTextModel(),
      contents: [{ role: "user", parts: [{ text: prompt }] }],
    });
    const raw = (result.text ?? "").trim();
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed.slice(0, 8).map((s: unknown) => String(s).toLowerCase());
    return [];
  } catch (err) {
    logger.error(err, "[insights] Gemini suggestions fallback failed");
    return [];
  }
}

export async function getInsightsSuggestions(q: string): Promise<SuggestionsResult> {
  if (!q || q.trim().length < 1) {
    // Return popular crops as defaults
    const { data } = await supabase
      .from("crop_reports")
      .select("crop_type")
      .not("crop_type", "is", null)
      .limit(100);

    const counts: Record<string, number> = {};
    for (const row of (data ?? []) as Array<{ crop_type: string | null }>) {
      if (row.crop_type) {
        const c = row.crop_type.toLowerCase();
        counts[c] = (counts[c] ?? 0) + 1;
      }
    }

    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name]) => name);

    return { suggestions: top };
  }

  const dbSuggestions = await fetchDbSuggestions(q);

  let suggestions = dbSuggestions;
  if (dbSuggestions.length < MIN_DB_SUGGESTIONS) {
    const geminiSuggestions = await fetchGeminiSuggestions(q);
    suggestions = [...new Set([...dbSuggestions, ...geminiSuggestions])].slice(0, 10);
  }

  return { suggestions };
}
