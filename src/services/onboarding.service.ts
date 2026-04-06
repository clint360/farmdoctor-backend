import { getUser, updateUser } from './user.service';
import { sendMessage } from './telegram.service';

/**
 * Handles the state machine for first-time user onboarding.
 * Returns true if the message was consumed by onboarding, false otherwise.
 */
export const processOnboarding = async (chatId: number, text?: string): Promise<boolean> => {
  const user = await getUser(chatId);

  // Allow resetting preferences at any time
  if (text === '/settings' || text === '/start') {
    await updateUser(chatId, { onboarding_step: 1, has_onboarded: false });
    await sendMessage(chatId, 'Welcome to Farm Doctor! Your AI agrarian advisor.');
    await sendLanguagePrompt(chatId);
    return true;
  }

  if (user.has_onboarded) {
    return false;
  }

  const msgText = text?.trim() || '';

  // Users can skip optional steps
  if (msgText.toLowerCase() === 'skip') {
    if (user.onboarding_step === 1) {
      await updateUser(chatId, { language: 'en', onboarding_step: 2 });
      await sendLocationPrompt(chatId);
    } else if (user.onboarding_step === 2) {
      await updateUser(chatId, { has_onboarded: true, onboarding_step: 3 });
      await sendMessage(chatId, "Setup complete! Ask me any farming questions or send me pictures of sick crops! Change preferences later with /settings.");
    }
    return true;
  }

  switch (user.onboarding_step) {
    case 0:
    case 1:
      // Handle Language Selection
      const lang = parseLanguage(msgText);
      if (lang) {
        await updateUser(chatId, { language: lang, onboarding_step: 2 });
        await sendLocationPrompt(chatId);
      } else {
        await sendLanguagePrompt(chatId);
      }
      return true;

    case 2:
      // Handle Location Selection
      await updateUser(chatId, { location: msgText, has_onboarded: true, onboarding_step: 3 });
      await sendMessage(chatId, "Setup complete! Ask me any farming questions or send me pictures of sick crops! Change preferences later with /settings.");
      return true;

    default:
      return false;
  }
};

const sendLanguagePrompt = async (chatId: number) => {
  await sendMessage(chatId, 'Please select your preferred language:', {
    keyboard: [[{ text: 'English' }, { text: 'Français' }, { text: 'Pidgin' }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  });
};

const sendLocationPrompt = async (chatId: number) => {
  await sendMessage(chatId, 'Great! Where is your farm located? (Send text, or type "Skip")', {
    keyboard: [[{ text: 'Skip' }]],
    resize_keyboard: true,
    one_time_keyboard: true,
  });
};

const parseLanguage = (text: string): 'en' | 'fr' | 'pidgin' | null => {
  const t = text.toLowerCase();
  if (t.includes('en') || t.includes('english')) return 'en';
  if (t.includes('fr') || t.includes('français') || t.includes('french')) return 'fr';
  if (t.includes('pidgin')) return 'pidgin';
  return null;
};
