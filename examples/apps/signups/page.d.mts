// Types for this repository's own type check.
export interface SignupForm {
  dataset: { trackingId?: string };
  addEventListener(type: 'submit', listener: (event: { preventDefault(): void }) => Promise<void>): void;
}

export function wireSignupForm(form: SignupForm): void;
