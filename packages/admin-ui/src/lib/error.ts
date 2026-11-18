/** 统一错误信息提取（ApiError / Error / unknown）。 */
export function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
