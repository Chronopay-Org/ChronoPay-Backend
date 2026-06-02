/**
 * Localized error messages for Spanish (es).
 * These map directly to i18n keys in errorTaxonomy.ts.
 */
export const ES_MESSAGES = {
  errors: {
    validation: {
      bad_request: "Solicitud inválida",
      validation_error: "Error de validación",
      missing_required_field: "Campo requerido faltante",
      invalid_payload: "Carga útil inválida",
      malformed_json: "Carga útil JSON mal formada",
    },
    auth: {
      unauthorized: "No autorizado",
      authentication_required: "Autenticación requerida",
      invalid_token: "Token inválido o expirado",
      invalid_api_key: "Clave API inválida",
      invalid_signature: "Firma inválida",
      invalid_timestamp: "Marca de tiempo inválida",
      timestamp_out_of_skew: "Marca de tiempo fuera del rango aceptable",
    },
    authz: {
      forbidden: "Prohibido",
      insufficient_permissions: "Permisos insuficientes",
      invalid_role: "Rol inválido",
    },
    ratelimit: {
      rate_limited: "Límite de velocidad excedido",
    },
    feature: {
      feature_disabled: "La función está deshabilitada",
    },
    idempotency: {
      key_invalid: "Clave de idempotencia inválida",
      in_progress: "La solicitud con esta clave de idempotencia está en progreso",
      key_mismatch: "No coincidencia de clave de idempotencia",
      replay_detected: "Repetición detectada",
    },
    content: {
      unsupported_media_type: "Tipo de medio no admitido",
      not_acceptable: "No aceptable",
    },
    resource: {
      not_found: "Recurso no encontrado",
      conflict: "Conflicto",
      unprocessable_entity: "Entidad no procesable",
    },
    internal: {
      db_error: "Error de base de datos",
      internal_error: "Error interno del servidor",
      service_unavailable: "Servicio no disponible",
      configuration_error: "Error de configuración",
      feature_flag_evaluation_error: "Error en la evaluación de la bandera de función",
    },
  },
} as const;
