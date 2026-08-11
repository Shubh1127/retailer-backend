/**
 * What counts as an acceptable password.
 *
 * THIS FILE IS THE AUTHORITY. The retailer app carries a copy of these rules so
 * it can tick the checklist as someone types, but that copy is a convenience and
 * this one decides — a browser check is a hint to a cooperative user and no
 * obstacle at all to anyone posting straight at the API.
 *
 * WHY THE FAILURES ARE RETURNED AS A LIST
 *
 * "Password is not strong enough" makes a person guess which rule they missed,
 * and they usually guess wrong and try again with the same fault. Every unmet
 * rule comes back named, so the form can show all of them at once.
 *
 * WHAT IS DELIBERATELY NOT HERE
 *
 * No maximum length, no forced rotation, and no banned-character set. A cap on
 * length pushes people toward shorter passwords and breaks password managers;
 * rotation makes people append a digit to what they already had. Length is the
 * signal that actually matters, which is why the minimum is 8 rather than the 6
 * Supabase would otherwise accept.
 */

/** Machine-readable so a caller can map a failure to a field or a checklist row. */
export type PasswordRule =
  | 'length'
  | 'uppercase'
  | 'number'
  | 'special';

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Anything that is not a letter, a digit, or whitespace.
 *
 * Defined by exclusion on purpose. An allow-list of punctuation always misses
 * something a keyboard somewhere produces, and rejecting a character a person
 * chose is the kind of rule that makes a password box feel broken. Whitespace
 * is excluded so a trailing space, which is invisible and usually a typo,
 * cannot be the one thing satisfying the rule.
 */
const SPECIAL = /[^A-Za-z0-9\s]/;

export const PASSWORD_RULES: { rule: PasswordRule; label: string; test: (value: string) => boolean }[] = [
  {
    rule: 'length',
    label: `At least ${MIN_PASSWORD_LENGTH} characters`,
    test: (value) => value.length >= MIN_PASSWORD_LENGTH,
  },
  {
    rule: 'uppercase',
    label: 'One capital letter',
    test: (value) => /[A-Z]/.test(value),
  },
  {
    rule: 'number',
    label: 'One number',
    test: (value) => /[0-9]/.test(value),
  },
  {
    rule: 'special',
    label: 'One special character',
    test: (value) => SPECIAL.test(value),
  },
];

export interface PasswordCheck {
  ok: boolean;
  /** Rules the password does NOT satisfy. Empty when `ok`. */
  failed: PasswordRule[];
  /** The same failures as sentences, ready to show. */
  messages: string[];
}

export function checkPassword(password: string): PasswordCheck {
  // No trimming. A password is the exact bytes the person typed; trimming it
  // here would accept one string and store another, and they would then be
  // unable to sign in with what they entered.
  const value = typeof password === 'string' ? password : '';

  const failures = PASSWORD_RULES.filter((rule) => !rule.test(value));

  return {
    ok: failures.length === 0,
    failed: failures.map((rule) => rule.rule),
    messages: failures.map((rule) => rule.label),
  };
}
