import 'dotenv/config';

async function test() {
  try {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      console.log('No GEMINI_API_KEY found in .env');
      return;
    }
    
    // Hit the pure REST endpoint bypassing SDK mappings
    const req = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    const data = await req.json() as any;
    
    if (data.models) {
      console.log('--- YOUR AUTHORIZED MODELS ---');
      data.models.forEach((m: any) => {
        if (m.name.includes('gemini') && m.supportedGenerationMethods?.includes('generateContent')) {
          console.log(m.name);
        }
      });
    } else {
      console.log('API Error:', data);
    }
  } catch (e) {
    console.error(e);
  }
}

test();
