-- CreateEnum
CREATE TYPE "TelegramAuthCodeKind" AS ENUM ('GROUP', 'MEMBER');

-- CreateEnum
CREATE TYPE "TelegramUpdateStatus" AS ENUM ('received', 'processing', 'succeeded', 'failed');

-- CreateEnum
CREATE TYPE "TelegramPendingStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TelegramFinancialOperationKind" AS ENUM ('TRANSACTION', 'INSTALLMENT_PLAN');

-- CreateEnum
CREATE TYPE "TelegramFinancialOperationStatus" AS ENUM ('CREATED', 'UNDONE');

-- CreateTable
CREATE TABLE "TelegramAuthorizedGroup" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "familyId" TEXT NOT NULL,
    "authorizedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TelegramAuthorizedGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramUserLink" (
    "id" TEXT NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "memberProfileId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "TelegramUserLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramAuthCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "TelegramAuthCodeKind" NOT NULL,
    "userId" TEXT,
    "memberProfileId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramPendingConfirmation" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" INTEGER,
    "memberProfileId" TEXT NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "TelegramPendingStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "TelegramPendingConfirmation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramUpdate" (
    "updateId" TEXT NOT NULL,
    "status" "TelegramUpdateStatus" NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "TelegramUpdate_pkey" PRIMARY KEY ("updateId")
);

-- CreateTable
CREATE TABLE "TelegramFinancialOperation" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "kind" "TelegramFinancialOperationKind" NOT NULL,
    "status" "TelegramFinancialOperationStatus" NOT NULL DEFAULT 'CREATED',
    "memberProfileId" TEXT NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "sourceUpdateId" TEXT,
    "sourceMessageId" INTEGER,
    "pendingConfirmationId" TEXT,
    "transactionId" TEXT,
    "installmentPlanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoPendingConfirmationId" TEXT,

    CONSTRAINT "TelegramFinancialOperation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TelegramFinancialOperation_one_effect_chk" CHECK (
        "status" = 'UNDONE' OR (
            (CASE WHEN "transactionId" IS NULL THEN 0 ELSE 1 END) +
            (CASE WHEN "installmentPlanId" IS NULL THEN 0 ELSE 1 END) = 1
        )
    )
);

-- CreateTable
CREATE TABLE "TelegramMessageLog" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "memberProfileId" TEXT,
    "textRaw" TEXT NOT NULL,
    "aiResponseJson" JSONB,
    "model" TEXT,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "costUsd" DECIMAL(10,6),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramMessageLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAuthorizedGroup_chatId_key" ON "TelegramAuthorizedGroup"("chatId");

-- CreateIndex
CREATE INDEX "TelegramAuthorizedGroup_familyId_idx" ON "TelegramAuthorizedGroup"("familyId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUserLink_tgUserId_chatId_key" ON "TelegramUserLink"("tgUserId", "chatId");

-- CreateIndex
CREATE INDEX "TelegramUserLink_memberProfileId_idx" ON "TelegramUserLink"("memberProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAuthCode_code_key" ON "TelegramAuthCode"("code");

-- CreateIndex
CREATE INDEX "TelegramAuthCode_kind_expiresAt_idx" ON "TelegramAuthCode"("kind", "expiresAt");

-- CreateIndex
CREATE INDEX "TelegramAuthCode_userId_idx" ON "TelegramAuthCode"("userId");

-- CreateIndex
CREATE INDEX "TelegramAuthCode_memberProfileId_idx" ON "TelegramAuthCode"("memberProfileId");

-- CreateIndex
CREATE INDEX "TelegramPendingConfirmation_chatId_tgUserId_status_idx" ON "TelegramPendingConfirmation"("chatId", "tgUserId", "status");

-- CreateIndex
CREATE INDEX "TelegramPendingConfirmation_expiresAt_idx" ON "TelegramPendingConfirmation"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramFinancialOperation_idempotencyKey_key" ON "TelegramFinancialOperation"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramFinancialOperation_transactionId_key" ON "TelegramFinancialOperation"("transactionId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramFinancialOperation_installmentPlanId_key" ON "TelegramFinancialOperation"("installmentPlanId");

-- CreateIndex
CREATE INDEX "TelegramFinancialOperation_memberProfileId_tgUserId_status_createdAt_idx" ON "TelegramFinancialOperation"("memberProfileId", "tgUserId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TelegramFinancialOperation_sourceUpdateId_idx" ON "TelegramFinancialOperation"("sourceUpdateId");

-- CreateIndex
CREATE INDEX "TelegramMessageLog_createdAt_idx" ON "TelegramMessageLog"("createdAt");

-- CreateIndex
CREATE INDEX "TelegramMessageLog_chatId_messageId_idx" ON "TelegramMessageLog"("chatId", "messageId");

-- AddForeignKey
ALTER TABLE "TelegramAuthorizedGroup" ADD CONSTRAINT "TelegramAuthorizedGroup_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "Family"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramAuthorizedGroup" ADD CONSTRAINT "TelegramAuthorizedGroup_authorizedByUserId_fkey" FOREIGN KEY ("authorizedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramUserLink" ADD CONSTRAINT "TelegramUserLink_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramAuthCode" ADD CONSTRAINT "TelegramAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramAuthCode" ADD CONSTRAINT "TelegramAuthCode_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "MemberProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramPendingConfirmation" ADD CONSTRAINT "TelegramPendingConfirmation_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramFinancialOperation" ADD CONSTRAINT "TelegramFinancialOperation_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "MemberProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramFinancialOperation" ADD CONSTRAINT "TelegramFinancialOperation_sourceUpdateId_fkey" FOREIGN KEY ("sourceUpdateId") REFERENCES "TelegramUpdate"("updateId") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramFinancialOperation" ADD CONSTRAINT "TelegramFinancialOperation_pendingConfirmationId_fkey" FOREIGN KEY ("pendingConfirmationId") REFERENCES "TelegramPendingConfirmation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramFinancialOperation" ADD CONSTRAINT "TelegramFinancialOperation_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramFinancialOperation" ADD CONSTRAINT "TelegramFinancialOperation_installmentPlanId_fkey" FOREIGN KEY ("installmentPlanId") REFERENCES "InstallmentPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramFinancialOperation" ADD CONSTRAINT "TelegramFinancialOperation_undoPendingConfirmationId_fkey" FOREIGN KEY ("undoPendingConfirmationId") REFERENCES "TelegramPendingConfirmation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramMessageLog" ADD CONSTRAINT "TelegramMessageLog_memberProfileId_fkey" FOREIGN KEY ("memberProfileId") REFERENCES "MemberProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
