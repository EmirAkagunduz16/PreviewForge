export class AuthFlowError extends Error {
  override readonly name = "AuthFlowError";

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
