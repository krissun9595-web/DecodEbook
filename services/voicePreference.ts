// The user's chosen read-aloud voice (VOICE_SYNTH), shared across the reader and the AI assistant
// so HD read-aloud everywhere uses the SAME voice. Persisted so it survives reloads.
const KEY = 'decodebook_tts_voice_v1';
const DEFAULT_VOICE = 'Puck';
let current: string | null = null;

export const getSelectedVoice = (): string => {
  if (current) return current;
  try { current = localStorage.getItem(KEY); } catch { /* storage blocked */ }
  return current || DEFAULT_VOICE;
};

export const setSelectedVoice = (voice: string): void => {
  if (!voice) return;
  current = voice;
  try { localStorage.setItem(KEY, voice); } catch { /* storage blocked */ }
};
