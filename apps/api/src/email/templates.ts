// E3: checked-in, versioned email templates. Each render bumps nothing — the
// VERSION map is bumped by hand when a template's copy/layout changes, and the
// version used is stamped on every email_messages row so historical sends stay
// attributable to the exact template that produced them.

export type EmailTemplate = "recall_letter" | "huddle_digest" | "statement_notice" | "appeal_sent";

export const TEMPLATE_VERSIONS: Record<EmailTemplate, number> = {
  recall_letter: 1,
  huddle_digest: 1,
  statement_notice: 1,
  appeal_sent: 1
};

export interface RenderedEmail {
  template: EmailTemplate;
  templateVersion: number;
  subject: string;
  bodyHtml: string;
}

const wrap = (title: string, inner: string, locationName: string) => `
<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#1d2b26">
  <div style="border-bottom:2px solid #1d4d3e;padding:16px 0;margin-bottom:20px">
    <strong style="font-size:18px">${locationName}</strong>
  </div>
  <h2 style="font-size:16px;margin:0 0 12px">${title}</h2>
  ${inner}
  <div style="border-top:1px solid #d8e2dd;margin-top:24px;padding-top:12px;font-size:12px;color:#5c6f68">
    ${locationName} · This mailbox is not monitored — please call the office to reach us.
  </div>
</div>`;

export function recallLetter(input: {
  locationName: string; patientFirst: string; dueSince: string;
}): RenderedEmail {
  return {
    template: "recall_letter",
    templateVersion: TEMPLATE_VERSIONS.recall_letter,
    subject: `${input.locationName}: you're due for a hygiene visit`,
    bodyHtml: wrap(
      "Time for your next visit",
      `<p>Hi ${input.patientFirst},</p>
       <p>Our records show you've been due for a hygiene visit since
       <strong>${input.dueSince}</strong>. Regular cleanings are the easiest way to keep
       small problems small — and your insurance benefits typically cover them.</p>
       <p>Call us or reply to a text from our office and we'll find a time that works.</p>`,
      input.locationName
    )
  };
}

export function huddleDigest(input: {
  locationName: string; date: string; narrative: string;
  actionItems: Array<{ title: string; priority: string }>;
}): RenderedEmail {
  const items = input.actionItems.length
    ? `<ol style="padding-left:20px">${input.actionItems
        .map((a) => `<li style="margin-bottom:6px">${a.title} <em style="color:#5c6f68">(${a.priority})</em></li>`)
        .join("")}</ol>`
    : "<p><em>No action items today.</em></p>";
  return {
    template: "huddle_digest",
    templateVersion: TEMPLATE_VERSIONS.huddle_digest,
    subject: `Morning huddle — ${input.locationName}, ${input.date}`,
    bodyHtml: wrap(
      `Morning huddle for ${input.date}`,
      `<p style="line-height:1.5">${input.narrative}</p>
       <h3 style="font-size:14px;margin:16px 0 8px">Today's actions</h3>${items}`,
      input.locationName
    )
  };
}

export function statementNotice(input: {
  locationName: string; patientFirst: string; pendingInsurance: number; lastVisit: string | null;
}): RenderedEmail {
  return {
    template: "statement_notice",
    templateVersion: TEMPLATE_VERSIONS.statement_notice,
    subject: `${input.locationName}: your account statement`,
    bodyHtml: wrap(
      "Account statement",
      `<p>Hi ${input.patientFirst},</p>
       <p>Here's a summary of your account${input.lastVisit ? ` since your visit on <strong>${input.lastVisit}</strong>` : ""}:</p>
       <p style="font-size:15px">Insurance currently processing: <strong>$${input.pendingInsurance.toFixed(2)}</strong></p>
       <p>You don't need to do anything right now — once your insurance finalizes, we'll
       send any remaining patient portion. Questions? Call the office and we'll walk
       through it together.</p>`,
      input.locationName
    )
  };
}

export function appealSentNotice(input: {
  locationName: string; patientFirst: string; carrierName: string; dateService: string | null;
}): RenderedEmail {
  return {
    template: "appeal_sent",
    templateVersion: TEMPLATE_VERSIONS.appeal_sent,
    subject: `${input.locationName}: we're appealing your insurance claim`,
    bodyHtml: wrap(
      "We're working on your claim",
      `<p>Hi ${input.patientFirst},</p>
       <p>${input.carrierName} initially denied the claim for your visit
       ${input.dateService ? `on <strong>${input.dateService}</strong>` : "on file"} — and we don't agree.
       Our billing team has filed a formal appeal on your behalf.</p>
       <p>No action is needed from you. We'll be in touch when the carrier responds;
       most appeals resolve within a few weeks.</p>`,
      input.locationName
    )
  };
}
