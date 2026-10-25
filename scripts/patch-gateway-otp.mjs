import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checkoutFile = path.join(
  projectRoot,
  'gateway',
  'apps',
  'checkout-portal',
  'src',
  'views',
  'checkout.html',
);

const START = '<!-- AURA_DEMO_OTP_AUTOFILL_START -->';
const END = '<!-- AURA_DEMO_OTP_AUTOFILL_END -->';

const BLOCK = `${START}
    <script id="aura-dev-otp-autofill">
      (function () {
        'use strict';

        function otpStepVisible() {
          var step = document.getElementById('authStepOtp');
          return !!step && !step.hidden;
        }

        function fill() {
          var otp = String(window.lastReceivedDevOtp || '');
          if (!/^\\d{6}$/.test(otp)) return;
          if (!otpStepVisible()) return;

          var input = document.getElementById('authOtpInput');
          if (!input || input.value === otp) return;

          input.value = otp;
          // The hosted checkout auto-submits when the input event carries six
          // digits. Clicking the button as well would fire a second verify
          // request after the first succeeds and surface a spurious 400.
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        window.setInterval(fill, 400);
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) fill();
        });
      })();
    </script>
    ${END}`;

export function patchCheckoutOtp() {
  if (!fs.existsSync(checkoutFile)) {
    throw new Error(
      `Checkout page not found at ${checkoutFile}. Is the gateway cloned into gateway/?`,
    );
  }

  const html = fs.readFileSync(checkoutFile, 'utf8');
  const existing = new RegExp(
    `${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`,
  );
  const cleaned = html.replace(existing, '');

  if (!cleaned.includes('</body>')) {
    throw new Error('Could not find </body> in the checkout page.');
  }

  const patched = cleaned.replace('</body>', `${BLOCK}\n</body>`);
  fs.writeFileSync(checkoutFile, patched, 'utf8');
  return { file: checkoutFile, replaced: existing.test(html) };
}

const isMain =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    const result = patchCheckoutOtp();
    console.log(
      `${result.replaced ? 'Updated' : 'Added'} demo OTP autofill in ${path.relative(projectRoot, result.file)}.`,
    );
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}
