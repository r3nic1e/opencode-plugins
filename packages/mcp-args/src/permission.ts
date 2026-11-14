export type Request = { action: string; resources: readonly unknown[]; metadata?: Record<string, unknown> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function permissionDetails(request: Request | undefined): Record<string, unknown> | undefined {
  const metadata = request?.metadata
  if (!metadata) return undefined
  const details = isRecord(metadata.input) ? metadata.input : metadata
  return Object.keys(details).length ? details : undefined
}
