import type { ItemKind, Owner } from '../../shared/types.ts';

export interface ClassifyInput { text: string; people: { name: string; aliases: string[] }[]; projects: { title: string; aliases: string[] }[]; now: string }
export interface ClassifyOutput { kind: ItemKind | 'question'; confidence: number /* 0..1 */; personName: string | null; projectName: string | null; owner: Owner }
/** Rejects with LlmError on any failure or invalid output. */
export interface Classifier { classify(input: ClassifyInput, signal?: AbortSignal): Promise<ClassifyOutput> }
export interface AnswerInput { question: string; now: string; excerpts: { ref: string; title: string; text: string }[] }   // ref like "note:12"
export interface AnswerOutput { answer: string; cited: string[] }
/** Rejects with LlmError on any failure or invalid output. `cited` only holds refs that were in `excerpts`. */
export interface Answerer { answer(input: AnswerInput, signal?: AbortSignal): Promise<AnswerOutput> }
export type AudioFormat = 'webm' | 'm4a' | 'ogg' | 'wav';
export interface Transcriber { transcribe(audio: Buffer, format: AudioFormat, signal?: AbortSignal): Promise<{ text: string }> }
export class LlmError extends Error {
  constructor(message?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LlmError';
  }
}
