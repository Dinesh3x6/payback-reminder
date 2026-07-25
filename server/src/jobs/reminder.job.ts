import cron from "node-cron";
import { prisma } from "@/config/prisma";
import { env } from "@/config/env";
import { generateUpiQrBuffer, buildUpiPaymentString } from "@/services/qrcode.service";
import { sendReminderEmail } from "@/services/email.service";

const FREQUENCY_TO_DAYS: Record<string, number> = {
  DAILY: 1,
  WEEKLY: 7,
  MONTHLY: 30,
};

/** Returns true if enough time has passed since the last reminder for this frequency. */
function isDueForReminder(frequency: string, lastSentAt: Date | null): boolean {
  if (frequency === "NONE") return false;
  if (!lastSentAt) return true;

  const intervalDays = FREQUENCY_TO_DAYS[frequency] ?? 7;
  const msSinceLast = Date.now() - lastSentAt.getTime();
  return msSinceLast >= intervalDays * 24 * 60 * 60 * 1000;
}

/** Sends reminder emails for every eligible, unpaid borrower with an email on file. */
export async function runReminderSweep() {
  const candidates = await prisma.borrower.findMany({
    where: {
      remindersActive: true,
      status: { not: "PAID" },
      email: { not: null },
    },
    include: { user: true },
  });

  let sent = 0;
  let failed = 0;

  for (const borrower of candidates) {
    if (!isDueForReminder(borrower.reminderFrequency, borrower.lastReminderSentAt)) continue;
    if (!borrower.email) continue;

    try {
      const payeeUpiId = borrower.user.upiId || "your-upi-id@bank";
      const amount = Number(borrower.remainingAmount);
      const qrBuffer = await generateUpiQrBuffer({
        payeeUpiId,
        payeeName: borrower.user.name,
        amount,
        note: `Repayment from ${borrower.name}`,
      });
      const upiLink = buildUpiPaymentString({
        payeeUpiId,
        payeeName: borrower.user.name,
        amount,
        note: `Repayment from ${borrower.name}`,
      });

      await sendReminderEmail({
        to: borrower.email,
        borrowerName: borrower.name,
        amount,
        dueDate: borrower.dueDate,
        qrCodeBuffer: qrBuffer,
        upiLink,
        note: borrower.notes ?? undefined,
      });

      await prisma.$transaction([
        prisma.borrower.update({
          where: { id: borrower.id },
          data: { lastReminderSentAt: new Date() },
        }),
        prisma.reminderLog.create({
          data: { borrowerId: borrower.id, channel: "email", success: true },
        }),
      ]);
      sent++;
    } catch (err: any) {
      failed++;
      await prisma.reminderLog.create({
        data: {
          borrowerId: borrower.id,
          channel: "email",
          success: false,
          errorMsg: String(err?.message ?? err),
        },
      });
      console.error(`[reminder] Failed to email borrower ${borrower.id}:`, err);
    }
  }

  console.log(`[reminder] Sweep complete. Sent: ${sent}, Failed: ${failed}, Checked: ${candidates.length}`);
  return { sent, failed, checked: candidates.length };
}

/** Registers the daily cron schedule. Call once at server startup. */
export function scheduleReminderJob() {
  cron.schedule(env.reminderCron, () => {
    runReminderSweep().catch((err) => console.error("[reminder] Sweep crashed:", err));
  });
  console.log(`[reminder] Cron scheduled with expression "${env.reminderCron}"`);
}
