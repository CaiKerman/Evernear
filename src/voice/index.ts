import { Realtime, type VoiceOptions } from '../providers.js';
import type { VoiceSession } from './base.js';
import { voiceProvider } from '../voice-config.js';
import { OpenAIVoice } from './openai.js';
import { GeminiVoice } from './gemini.js';
import { DoubaoVoice } from './doubao.js';
export type { VoiceSession } from './base.js';
export function createVoice(options:VoiceOptions):VoiceSession{
  switch(voiceProvider(options.config)){
    case 'openai':return new OpenAIVoice(options);
    case 'gemini':return new GeminiVoice(options);
    case 'doubao':return new DoubaoVoice(options);
    default:return new Realtime(options);
  }
}
