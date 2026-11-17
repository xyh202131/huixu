import { createHash, randomUUID } from 'node:crypto';
import { RegistrationError } from './registrationStore.js';

export function publicRegistrationOrigin(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) return '';
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return '';
  return url.origin;
}

export function createRegistrationMail(store, env, endpoint = 'https://api.resend.com') {
  const { db, now, transaction, findEvent, personFor, tokenFor, issueLink, mailSelect } = store.mail;
  const key = env.HUIXU_RESEND_API_KEY?.trim();
  const sender = env.HUIXU_MAIL_FROM?.trim();
  const origin = publicRegistrationOrigin(env.HUIXU_PUBLIC_ORIGIN);
  const configured = Boolean(key && sender && origin);
  const reason = !origin ? '请先配置参与者可访问的 HTTPS 地址。' : '请先配置 Resend 密钥和已验证的发件地址。';
  const fingerprint = value => createHash('sha256').update(value).digest('hex');

  function records(owner, eventId) {
    findEvent(eventId, owner);
    const records = db.prepare(mailSelect + " AND status <> 'draft' ORDER BY rowid DESC LIMIT 150").all(eventId)
      .map(({ startedAt, ...record }) => {
        if (record.status === 'pending' && startedAt && now() - startedAt > 30000) {
          return { ...record, status: 'unknown', error: '提交中断，请在邮件服务后台核对。' };
        }
        return record;
      });
    return { configured, reason: configured ? '' : reason, records };
  }

  function preview(owner, eventId, personId) {
    return transaction(() => {
      if (!configured) throw new RegistrationError(409, reason);
      const row = findEvent(eventId, owner);
      const person = personFor(eventId, personId);
      if (!person.email) throw new RegistrationError(409, '请先在报名记录里补充邮箱。');
      const event = JSON.parse(row.snapshot);
      const link = issueLink(owner, eventId, personId);
      const id = randomUUID();
      const subject = event.title + ' · 请确认出席';
      const session = event.agenda.find(item => item.id === person.sessionId);
      const body = [
        person.name + '，你好！', '', '请确认你是否出席「' + event.title + '」。',
        '日期：' + (event.date || '待确认'), '地点：' + (event.venue || '待确认'),
        '场次：' + (session ? session.title + ' · ' + session.start + '–' + session.end : '全场活动'),
        '', '打开专属确认页后，可确认出席、报告无法参加或申请更换分场。链接在 7 天内有效。',
      ].join('\n');
      db.prepare(`INSERT INTO signup_mail (id, event_id, person_id, person_revision, event_revision, link_id,
        recipient, subject, body, origin, sender, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`)
        .run(id, eventId, personId, person.revision, fingerprint(row.snapshot), link.id, person.email, subject, body, origin, sender, new Date(now()).toISOString());
      return { id, sender, recipient: person.email, subject, body, version: event.version, expires: link.expires, origin };
    });
  }

  function getMail(eventId, id) {
    const row = db.prepare('SELECT * FROM signup_mail WHERE event_id = ? AND id = ?').get(eventId, id);
    if (!row) throw new RegistrationError(404, '找不到邮件记录。');
    return row;
  }

  async function send(owner, eventId, id, retry) {
    if (!configured) throw new RegistrationError(409, reason);
    const row = transaction(() => {
      const event = findEvent(eventId, owner);
      const mail = getMail(eventId, id);
      if (mail.status !== (retry ? 'failed' : 'draft')) return null;
      const person = personFor(eventId, mail.person_id);
      const link = db.prepare('SELECT expires, revoked FROM signup_links WHERE id = ?').get(mail.link_id);
      if (mail.event_revision !== fingerprint(event.snapshot) || mail.person_revision !== person.revision ||
          mail.origin !== origin || mail.sender !== sender || link.revoked || link.expires <= now()) {
        throw new RegistrationError(409, '报名、活动、链接或发件配置已更新，请重新预览发送内容。');
      }
      db.prepare("UPDATE signup_mail SET status = 'pending', attempts = attempts + 1, error = NULL, started_at = ? WHERE id = ?").run(now(), id);
      return { ...mail, attempts: mail.attempts + 1 };
    });
    if (!row) return records(owner, eventId);
    let status = 'unknown';
    let error = '未收到可确认的提交结果，请在邮件服务后台核对。';
    let providerId = null;
    try {
      const response = await fetch(endpoint + '/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'Idempotency-Key': row.id + '/' + row.attempts },
        body: JSON.stringify({ from: row.sender, to: [row.recipient], subject: row.subject,
          text: row.body + '\n\n' + row.origin + '/#/attendance/' + tokenFor(row.link_id) }),
      });
      if (response.ok) {
        const result = await response.json();
        if (typeof result.id === 'string' && result.id) {
          status = 'accepted';
          providerId = result.id;
          error = null;
        }
      } else if (response.status >= 400 && response.status < 500 && ![408, 409].includes(response.status)) {
        status = 'failed';
        error = '邮件服务拒绝提交（HTTP ' + response.status + '）。';
      }
    } catch {
      // 超时、断线与不明确的服务响应保留为待核对，避免重复发信。
    }
    db.prepare('UPDATE signup_mail SET status = ?, provider_id = ?, error = ? WHERE id = ?').run(status, providerId, error, id);
    return records(owner, eventId);
  }

  async function refresh(owner, eventId, id) {
    findEvent(eventId, owner);
    const mail = getMail(eventId, id);
    if (!key || !mail.provider_id) return records(owner, eventId);
    const response = await fetch(endpoint + '/emails/' + encodeURIComponent(mail.provider_id), {
      headers: { Authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new RegistrationError(502, '邮件服务暂时无法返回投递状态。');
    const { last_event: lastEvent } = await response.json();
    const deliveryStatus = { delivered: 'delivered', opened: 'opened', clicked: 'clicked', bounced: 'bounced',
      failed: 'bounced', complained: 'complained', suppressed: 'bounced', delivery_delayed: 'delayed' }[lastEvent];
    if (deliveryStatus) db.prepare('UPDATE signup_mail SET status = ? WHERE id = ?').run(deliveryStatus, id);
    return records(owner, eventId);
  }

  return { records, preview, send, refresh, origin };
}
