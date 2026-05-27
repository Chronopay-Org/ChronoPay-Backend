/**
 * Validates that all required fields are present in the object.
 * @param obj - The object to validate.
 * @param requiredFields - Array of required field names.
 * @throws Error if any required field is missing.
 */
export function validateRequiredFields(obj: Record<string, any>, requiredFields: string[]): void {
  for (const field of requiredFields) {
    if (!(field in obj) || obj[field] === undefined || obj[field] === null) {
      throw new Error(`Missing required field: ${field}`);
    }
  }
}