import { filterResultText } from '../evidence';

type Pattern = {
  label: string;
  value: RegExp;
  valid?: (value: string) => boolean;
};

const integerChecksum = (value: string, modulus: number): number => {
  let remainder = 0;
  for (const char of value) {
    const decimal = char.charCodeAt(0) - 48;
    remainder =
      decimal > 9
        ? (remainder * 100 + decimal - 7) % modulus
        : (remainder * 10 + decimal) % modulus;
  }
  return remainder;
};

const iban = (value: string): boolean => {
  const number = value.replace(/ /g, '').toUpperCase();
  return (
    number.length >= 15 &&
    number.length <= 34 &&
    integerChecksum(number.slice(4) + number.slice(0, 4), 97) === 1
  );
};

const peselWeights = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3, 1];
const pesel = (value: string): boolean => {
  const month = Number(value.slice(2, 4)) % 20;
  const day = Number(value.slice(4, 6));
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    peselWeights.reduce(
      (sum, weight, index) => sum + weight * Number(value[index]),
      0,
    ) %
      10 ===
      0
  );
};

const dni = (value: string): boolean => {
  const normalized = value
    .toUpperCase()
    .replace(/^X/, '0')
    .replace(/^Y/, '1')
    .replace(/^Z/, '2');
  return (
    'TRWAGMYFPDXBNJZSQVHLCKE'[Number(normalized.slice(0, -1)) % 23] ===
    normalized.at(-1)
  );
};

const nif = (value: string): boolean => {
  const number = value.match(/\d{9}$/)?.[0];
  if (!number) return false;
  const sum = [...number.slice(0, -1)].reduce(
    (total, digit, index) => total + Number(digit) * (9 - index),
    0,
  );
  const check = 11 - (sum % 11);
  return Number(number.at(-1)) === (check > 9 ? 0 : check);
};

export const secretPatterns: readonly Pattern[] = [
  {
    label: 'Private key',
    value: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
  },
  {
    label: 'Access token',
    value:
      /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
  },
  {
    label: 'Credential assignment',
    value:
      /\b[\w.-]*(?:api[_-]?key|access[_-]?key|client[_-]?secret|token|password|secret)[\w.-]*["']?\s*[:=]\s*["'][^"'\r\n]{8,}["']/gi,
  },
  {
    label: 'Credential assignment',
    value:
      /\b[\w.-]*(?:api[_-]?key|access[_-]?key|client[_-]?secret|token|password|secret)[\w.-]*\s*=\s*[A-Za-z0-9_./+~-]{8,}/gi,
  },
  { label: 'Bearer credential', value: /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi },
];

export const personalPatterns: readonly Pattern[] = [
  {
    label: 'Email address',
    value:
      /\b[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]{1,64}@[A-Z0-9-]{1,63}(?:\.[A-Z0-9-]{1,63})*\.[A-Z]{2,63}\b/gi,
  },
  {
    label: 'IBAN',
    value: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g,
    valid: iban,
  },
  { label: 'National ID (PESEL)', value: /\b\d{11}\b/g, valid: pesel },
  {
    label: 'National ID (DNI or NIE)',
    value: /\b(?:\d{8}|[XYZ]\d{7})[A-Z]\b/gi,
    valid: dni,
  },
  {
    label: 'National ID (NIF)',
    value: /\bNIF\s*[:=]?\s*\d{9}\b/gi,
    valid: nif,
  },
  {
    label: 'Phone number',
    value:
      /(?<![\w+])(?:\+\d{1,3}(?:[ .-]?\d){7,13}|\(?\d{2,4}\)?[ .-]\d{2,4}[ .-]\d{2,4}(?:[ .-]\d{2,4})?)(?!\w)/g,
    valid: value => {
      const digits = value.replace(/\D/g, '').length;
      return digits >= 8 && digits <= 15;
    },
  },
];

export function detectedLabels(
  value: string,
  patterns: readonly Pattern[],
): string[] {
  const labels = new Set<string>();
  let remaining = value;
  for (const pattern of patterns)
    remaining = remaining.replace(pattern.value, match => {
      if (pattern.valid && !pattern.valid(match)) return match;
      labels.add(pattern.label);
      return ' ';
    });
  return [...labels];
}

export function maskProbeText(value: string): string {
  let text = value.replace(
    /-----BEGIN ([A-Z0-9 ]{0,40}PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g,
    '[masked]',
  );
  for (const { value: pattern, valid } of [
    ...secretPatterns,
    ...personalPatterns,
  ])
    text = text.replace(pattern, match =>
      (valid?.(match) ?? true) ? '[masked]' : match,
    );
  return filterResultText(text);
}
