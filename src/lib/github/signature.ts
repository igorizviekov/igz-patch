import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGitHubSignature({
  body,
  signature,
  secret,
}: {
  body: string;
  signature: string | null;
  secret: string;
}): boolean {
  if (!signature?.startsWith("sha256=")) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);

  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

