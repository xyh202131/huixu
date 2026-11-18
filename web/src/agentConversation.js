export const workspaceHistoryLimit = 20;

const chineseNumbers = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

export function executionChoice(question) {
  const match = question.normalize('NFKC').trim()
    .match(/^(?:请)?(?:就)?按(?:照)?[ \t]*(?:第[ \t]*([1-9]\d?|[一二两三四五六七八九十])[ \t]*个[ \t]*方案|方案[ \t]*([1-9]\d?|[一二两三四五六七八九十]))[ \t]*(?:执行|发布)(?:吧)?[。.!！]*$/);
  if (!match) return null;
  const number = match[1] ?? match[2];
  return Number(number) || (number === '两' ? 2 : chineseNumbers.indexOf(number));
}

export function summarizeExecutionImpact(impact) {
  return {
    rows: impact.rows.map(({ before, after, impact: change }) => ({
      before: { id: before.id, title: before.title, room: before.room, start: before.start, end: before.end },
      after, checkin: change.checkin, checkedIn: change.checkedIn, confirmed: change.notice.recipients.length,
      pending: change.registrations.filter(person => person.status === '待审核').length,
      waitlisted: change.registrations.filter(person => person.status === '候补').length,
      posts: change.posts.map(({ role, assignees }) => ({ role, count: assignees.length })),
    })),
    count: impact.count,
    notices: impact.notices.map(({ role, recipients, body }) => ({ role, count: recipients.length, body })),
  };
}

export function rememberTurn(event, question, result) {
  const proposal = result.proposal;
  const turn = { eventId: event.id, version: event.version, question, candidates: [], citations: (result.citations ?? []).slice(0, 5)
    .map(({ chunkId, revision }) => ({ chunkId, revision })) };
  if (proposal?.kind === 'move') {
    turn.sessionId = proposal.before.id;
    turn.selected = proposal.analysis.requested.issues.length && proposal.analysis.alternatives.length ? 2 : 1;
    turn.candidates = [proposal.analysis.requested, ...proposal.analysis.alternatives].slice(0, 5)
      .map(({ candidate }) => ({ room: candidate.room, start: candidate.start, end: candidate.end }));
  }
  if (proposal?.kind === 'rescue') {
    turn.selected = 1;
    turn.plans = proposal.analysis.plans.slice(0, 3).map(plan => plan.moves.slice(0, 12)
      .map(({ sessionId, room, start, end }) => ({ sessionId, room, start, end })));
  }
  if (!result.usedProjectMemory && !turn.citations.length && typeof result.answer === 'string') turn.answer = result.answer.slice(0, 600);
  return turn;
}

export function conversationContext(turns, event) {
  if (!Array.isArray(turns)) return [];
  return turns.slice(-4).filter(turn => turn && turn.eventId === event.id && typeof turn.question === 'string').map(turn => {
    const sameVersion = Number.isInteger(turn.version) && turn.version === event.version;
    const result = { question: turn.question.slice(0, 360), version: turn.version, stale: !sameVersion };
    if (!sameVersion) return result;
    if (typeof turn.answer === 'string') result.priorAnswer = turn.answer.slice(0, 600);
    function existingSlot(slot) {
      return slot && event.rooms.some(room => room.id === slot.room) && /^\d\d:\d\d$/.test(slot.start) && /^\d\d:\d\d$/.test(slot.end);
    }
    if (event.agenda.some(row => row.id === turn.sessionId) && Array.isArray(turn.candidates)) {
      result.sessionId = turn.sessionId;
      result.candidates = turn.candidates.slice(0, 5).flatMap((slot, i) => existingSlot(slot)
        ? [{ number: i + 1, room: slot.room, start: slot.start, end: slot.end }] : []);
      if (result.candidates.some(row => row.number === turn.selected)) result.selected = turn.selected;
    }
    if (Array.isArray(turn.plans)) {
      result.plans = [];
      for (const [index, plan] of turn.plans.slice(0, 3).entries()) {
        if (!Array.isArray(plan) || plan.length > 12 || !plan.length ||
          !plan.every(slot => existingSlot(slot) && event.agenda.some(row => row.id === slot.sessionId))) continue;
        result.plans.push({ number: index + 1, moves: plan.map(({ sessionId, room, start, end }) => ({ sessionId, room, start, end })) });
      }
      if (result.plans.some(plan => plan.number === turn.selected)) result.selected = turn.selected;
    }
    return result;
  });
}
