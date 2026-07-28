/**
 * Thrown when a `.geo.json` document cannot be parsed into a usable geometry.
 */
export class GeometryParseError extends Error {
  /**
   * @param message - Human-readable reason the document was rejected.
   */
  constructor(message: string) {
    super(message);
    this.name = "GeometryParseError";
  }
}
