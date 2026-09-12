export function signatureMailHeaders(pool = process.env.SENDGRID_IP_POOL) {
  return {
    'X-SMTPAPI': JSON.stringify({
      ...(pool ? { ip_pool: pool } : {}),
      filters: { clicktrack: { settings: { enable: 0, enable_text: 0 } } },
    }),
  };
}
