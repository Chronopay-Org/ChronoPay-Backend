export enum FraudReasonCode {
  RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED",
  DEVICE_UNRECOGNIZED = "DEVICE_UNRECOGNIZED",
  INVALID_CONTACT_INFO = "INVALID_CONTACT_INFO",
  UNKNOWN_RISK = "UNKNOWN_RISK"
}

export type Locale = "en" | "es" | "fr";

export const fraudReasonMessages: Record<FraudReasonCode, Record<Locale, string>> = {
  [FraudReasonCode.RATE_LIMIT_EXCEEDED]: {
    en: "You have made too many requests. Please try again later.",
    es: "Ha realizado demasiadas solicitudes. Por favor, inténtelo de nuevo más tarde.",
    fr: "Vous avez fait trop de demandes. Veuillez réessayer plus tard.",
  },
  [FraudReasonCode.DEVICE_UNRECOGNIZED]: {
    en: "We could not verify your device. Please log in again.",
    es: "No pudimos verificar su dispositivo. Por favor inicie sesión de nuevo.",
    fr: "Nous n'avons pas pu vérifier votre appareil. Veuillez vous reconnecter.",
  },
  [FraudReasonCode.INVALID_CONTACT_INFO]: {
    en: "The contact information provided is not accepted.",
    es: "La información de contacto proporcionada no es aceptada.",
    fr: "Les informations de contact fournies ne sont pas acceptées.",
  },
  [FraudReasonCode.UNKNOWN_RISK]: {
    en: "Your request was flagged for review.",
    es: "Su solicitud fue marcada para revisión.",
    fr: "Votre demande a été signalée pour examen.",
  }
};

export function getFraudReasonCode(internalReason: string): FraudReasonCode {
  switch (internalReason) {
    case "velocity_exceeded":
      return FraudReasonCode.RATE_LIMIT_EXCEEDED;
    case "fingerprint_mismatch":
      return FraudReasonCode.DEVICE_UNRECOGNIZED;
    case "user_agent_mismatch":
      return FraudReasonCode.DEVICE_UNRECOGNIZED;
    case "disposable_email":
      return FraudReasonCode.INVALID_CONTACT_INFO;
    default:
      return FraudReasonCode.UNKNOWN_RISK;
  }
}

export function getFraudMessage(code: FraudReasonCode, locale: Locale | string = "en"): string {
  const catalog = fraudReasonMessages[code];
  if (!catalog) return "Unknown risk.";
  return catalog[locale as Locale] ?? catalog["en"] ?? "Unknown risk.";
}
