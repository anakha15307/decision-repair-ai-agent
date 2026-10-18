// Imported conversation text and documents are untrusted data. This module never acts on
// that content; it only flags instruction-like text so reviewers can see it, and provides
// helpers to quote it safely when passing it to a model.

const INSTRUCTION_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "ignore_instructions", re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(instructions|rules|prompt|policy|guidelines)\b/i },
  { id: "role_override", re: /\b(you are now|act as|pretend to be|new instructions|developer mode)\b/i },
  { id: "system_marker", re: /(^|\n|\s)(system|assistant|developer)\s*:\s*\S/i },
  { id: "fake_markup", re: /<\/?(system|instructions?|admin|prompt)>/i },
  { id: "directive_to_reviewer", re: /\b(mark|classify|flag|set)\b[^.\n]{0,40}\b(case|this|record|finding)\b[^.\n]{0,40}\b(confirmed|approved|eligible|resolved|verified|no impact)\b/i },
  { id: "payout_directive", re: /\b(approve|issue|send|process)\b[^.\n]{0,30}\b(refund|payment|compensation|credit)\b[^.\n]{0,30}(\$\s?\d|immediately|now|automatically)/i },
];

export const UNTRUSTED_FLAG = "instruction_like_text";

/** Returns ids of instruction-like patterns found. Detection is heuristic and incomplete. */
export function detectInstructionLikeText(text: string): string[] {
  return INSTRUCTION_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.id);
}

/** Wrap untrusted content in clearly delimited, escaped blocks for a model prompt. */
export function quoteUntrusted(label: string, text: string): string {
  const escaped = text.replace(/<\/?untrusted[^>]*>/gi, "[tag removed]");
  return `<untrusted source="${label}">\n${escaped}\n</untrusted>`;
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /\+?\d[\d\s().-]{8,}\d/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;

/** Remove direct identifiers before any text leaves the server. */
export function redactIdentifiers(text: string): string {
  return text.replace(EMAIL, "[email]").replace(CARD, "[number]").replace(PHONE, "[phone]");
}
