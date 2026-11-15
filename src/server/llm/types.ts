import type { ItemKind, Owner } from '../../shared/types.ts';

export interface ClassifyInput { text: string; people: { name: string; aliases: string[] }[]; now: string }
export interface ClassifyOutput { kind: ItemKind; confidence: number /* 0..1 */; personName: string | null; owner: Owner }
/** Rejects with LlmError on any failure or invalid output. */
export interface Classifier { classify(input: ClassifyInput, signal?: AbortSignal): Promise<ClassifyOutput> }
export type AudioFormat = 'webm' | 'm4a' | 'ogg' | 'wav';
export interface Transcriber { transcribe(audio: Buffer, format: AudioFormat, signal?: AbortSignal): Promise<{ text: string }> }
export class LlmError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmError';
  }
}
