import nodemailer, { type SendMailOptions } from "nodemailer"
import { timedCheck, type CheckResult } from "../utils/timedCheck"

const smtp = {
  host: process.env.EMAIL_HOST || "smtp.gmail.com",
  port: Number(process.env.EMAIL_PORT) || 587,
  secure: Number(process.env.EMAIL_PORT) === 465,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
}

const transporter = nodemailer.createTransport({ ...smtp, connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000 })
// Its own short timeouts, so a check never leaves a socket open past its 3 s answer
const checker = nodemailer.createTransport({ ...smtp, connectionTimeout: 2500, greetingTimeout: 2500, socketTimeout: 2500 })

let sendMail = (mail: SendMailOptions): Promise<unknown> => transporter.sendMail(mail)

export function setTransportForTests(fake: typeof sendMail): void {
  sendMail = fake
}

const fromAddress = process.env.EMAIL_FROM || process.env.EMAIL_USER || "noreply@nerla.com"

/** True when SMTP credentials are present, so callers can offer a fallback */
export function isEmailConfigured(): boolean {
  return !!(process.env.EMAIL_USER && process.env.EMAIL_PASS)
}

/** Skipped when no mail account is set up, since the app then shows invite links instead of sending them */
export function checkEmail(): Promise<CheckResult> {
  return timedCheck(async () => {
    if (!isEmailConfigured()) return { skipped: true }
    await checker.verify()
  })
}

const clientUrl = () => process.env.CLIENT_URL || "http://localhost:3001"

/** The single definition of an invite link, shared by email and the admin UI */
export function buildInviteUrl(to: string, inviteToken: string): string {
  return `${clientUrl()}/sign-in?mode=activate&email=${encodeURIComponent(to)}&token=${encodeURIComponent(inviteToken)}`
}
export const signInLink = () => `${clientUrl()}/sign-in`
export const resetLink = (token: string) => `${clientUrl()}/sign-in?mode=reset&token=${encodeURIComponent(token)}`

const INK = "#1F2433"
const MUTED = "#58607A"
const FONT = "Figtree,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif"

function emailLayout(content: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background-color:#F7F8FA;font-family:${FONT};color:${INK};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#F7F8FA;padding:40px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;">
        <tr><td style="padding:0 0 20px 0;">
          <span style="font-size:20px;font-weight:600;color:#2F67BD;">Nerla</span>
        </td></tr>
        <tr><td style="background-color:#FFFFFF;border:1px solid #E8E9EE;border-radius:12px;padding:32px;">
          ${content}
        </td></tr>
        <tr><td style="padding:20px 0 0 0;text-align:center;">
          <p style="margin:0;font-size:12px;line-height:1.5;color:${MUTED};">Sent by Nerla because an action was taken on your account.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}

function emailHeading(text: string): string {
  return `<h1 style="margin:0 0 8px 0;font-size:20px;line-height:1.4;font-weight:600;color:${INK};">${text}</h1>`
}

function emailButton(href: string, label: string): string {
  return `<a href="${esc(href)}" style="display:inline-block;padding:10px 20px;background-color:#FF9CC8;color:${INK};font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">${label}</a>`
}

function emailNote(text: string): string {
  return `<p style="margin:24px 0 0 0;font-size:13px;line-height:1.5;color:${MUTED};">${text}</p>`
}

export async function sendInviteEmail(to: string, inviteToken: string, inviterName: string, orgName: string): Promise<void> {
  const setPasswordUrl = buildInviteUrl(to, inviteToken)

  const html = emailLayout(`
    ${emailHeading("You're invited")}
    <p style="margin:0 0 24px 0;font-size:15px;line-height:1.5;color:${MUTED};">
      <strong style="color:${INK};font-weight:600;">${esc(inviterName)}</strong> has invited you to join
      <strong style="color:${INK};font-weight:600;">${esc(orgName)}</strong> on Nerla.
    </p>
    ${emailButton(setPasswordUrl, "Set your password")}
    ${emailNote("This link expires in 7 days.")}
  `)

  await sendMail({
    from: fromAddress,
    to,
    subject: `${inviterName} invited you to ${orgName}`,
    text: `${inviterName} has invited you to join ${orgName} on Nerla.\n\nSet your password to get started:\n${setPasswordUrl}\n\nThis link expires in 7 days.`,
    html,
  })
}

/** Tells a removed account it was invited back. It carries no token, only the sign-in page */
export async function sendRejoinEmail(to: string, inviterName: string, orgName: string): Promise<void> {
  const signInUrl = signInLink()

  const html = emailLayout(`
    ${emailHeading("You're invited back")}
    <p style="margin:0 0 24px 0;font-size:15px;line-height:1.5;color:${MUTED};">
      <strong style="color:${INK};font-weight:600;">${esc(inviterName)}</strong> has invited you back to
      <strong style="color:${INK};font-weight:600;">${esc(orgName)}</strong>. Sign in to rejoin.
    </p>
    ${emailButton(signInUrl, "Sign in")}
    ${emailNote("The invite lasts 7 days.")}
  `)

  await sendMail({
    from: fromAddress,
    to,
    subject: `${inviterName} invited you back to ${orgName}`,
    text: `${inviterName} has invited you back to ${orgName}. Sign in to rejoin.

${signInUrl}

The invite lasts 7 days.`,
    html,
  })
}

export async function sendPasswordResetEmail(to: string, resetToken: string): Promise<void> {
  const resetUrl = resetLink(resetToken)

  const html = emailLayout(`
    ${emailHeading("Reset your password")}
    <p style="margin:0 0 24px 0;font-size:15px;line-height:1.5;color:${MUTED};">
      We received a request to reset the password for your Nerla account.
    </p>
    ${emailButton(resetUrl, "Reset password")}
    ${emailNote("This link expires in 1 hour. If you didn't request this, you can ignore this email.")}
  `)

  await sendMail({
    from: fromAddress,
    to,
    subject: "Reset your Nerla password",
    text: `You requested a password reset for your Nerla account.\n\nReset your password:\n${resetUrl}\n\nThis link expires in 1 hour. If you didn't request this, ignore this email.`,
    html,
  })
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
