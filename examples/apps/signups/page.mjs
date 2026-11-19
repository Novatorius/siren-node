// The Signups example's page half, for a page on one of the event's allowed
// domains. A bundler resolves the import. The package README shows the part
// between the README markers, and a test runs it.

// README: page
import { track } from '@novatorius/siren/storefront';

export function wireSignupForm(form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const collaboratorId = Number(form.dataset.collaboratorId);
    // track asks /siren/token for a browser token, keeps it, and sends.
    await track('newsletter-signup', { collaboratorId, list: 'weekly' });
  });
}
// README end
