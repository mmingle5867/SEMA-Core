-- Public keys programs register to sign their requests (RFC 9421) instead of sending a secret.
CREATE TABLE "sema_core_client_keys" (
  "keyId" TEXT NOT NULL,
  "applicationKey" TEXT NOT NULL,
  "publicJwk" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "sema_core_client_keys_pkey" PRIMARY KEY ("keyId")
);
CREATE INDEX "sema_core_client_keys_applicationKey_idx" ON "sema_core_client_keys"("applicationKey");
