/**
 * Operator details for the imprint and privacy pages.
 *
 * TODO(owner): replace every [PLACEHOLDER] with the real data before
 * going live. A German/EU imprint (Impressum, § 5 DDG) must name the
 * responsible person/company, a postal address and a fast contact
 * route. Have the privacy policy checked — this is a template, not
 * legal advice.
 */
export const OPERATOR = {
  name: "Selim Alcibuga",
  street: "[STREET AND NUMBER]",
  city: "[POSTCODE CITY]",
  country: "[COUNTRY]",
  email: "selimalcibuga@gmail.com",
  phone: "", // optional
  vatId: "", // only if you have one
};

/**
 * Days an idle project is kept on the server, per plan (counted from
 * the last change). Must match PLAN_RETENTION_DAYS in backend/jobs.py.
 */
export const RETENTION_DAYS = { Starter: 14, Pro: 30, Studio: 90 } as const;
