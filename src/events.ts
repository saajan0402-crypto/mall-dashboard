/**
 * セール・イベント（楽天スーパーSALE、お買い物マラソン、プライムデーなど）
 *
 * グラフの背景に色をつけて「この日はセールが効いている」と分かるようにするためのもの。
 * 全案件共通のイベントは最初から登録してあり（日程が未確認のものは estimated）、日付は画面から直せる。
 * 案件ごとに「参加しなかった」を選ぶと、その案件のグラフからは外れる。
 */

export interface SaleEvent {
  id: string; caseId: string | null; mall: "amazon" | "rakuten"; kind: string; name: string;
  startAt: string; endAt: string; presaleAt: string | null;
  source: "preset" | "manual"; confidence: "confirmed" | "estimated"; note: string | null;
  participating: boolean;
  /** グラフで色をつける日（日本時間の日付） */
  dayFrom: string; dayTo: string;
}

/**
 * 色をつける日。先行セールがあればその日から。
 * 楽天は「11日 01:59 まで」のように終わるので、終わりの3時間は前日に寄せる（11日はほぼ通常の日のため）
 */
export function eventDays(startAt: string, endAt: string, presaleAt?: string | null): { dayFrom: string; dayTo: string } {
  const toDate = (s: string) => new Date(s.replace(" ", "T") + ":00Z");
  const from = (presaleAt ?? startAt).slice(0, 10);
  const end = new Date(toDate(endAt).getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  return { dayFrom: from, dayTo: end < from ? from : end };
}

const valid = (s?: string | null) => !!s && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(s);

/** 期間にかかるイベント。案件がつないでいるモールのものだけ */
export async function listEvents(db: D1Database, caseId: string, from: string, to: string): Promise<SaleEvent[]> {
  const { results: mallRows } = await db.prepare(
    "SELECT mall FROM case_malls WHERE case_id = ? AND credentials_enc IS NOT NULL"
  ).bind(caseId).all<{ mall: string }>();
  const malls = mallRows.length ? mallRows.map((m) => m.mall) : ["amazon", "rakuten"];
  const { results } = await db.prepare(
    `SELECT e.*, COALESCE(p.participating, 1) AS participating
       FROM sale_events e
       LEFT JOIN case_event_participation p ON p.event_id = e.id AND p.case_id = ?
      WHERE (e.case_id IS NULL OR e.case_id = ?)
        AND substr(COALESCE(e.presale_at, e.start_at), 1, 10) <= ? AND substr(e.end_at, 1, 10) >= ?
      ORDER BY COALESCE(e.presale_at, e.start_at)`
  ).bind(caseId, caseId, to, from).all<Record<string, string | number | null>>();
  return results.filter((r) => malls.includes(String(r.mall))).map((r) => ({
    id: String(r.id), caseId: r.case_id == null ? null : String(r.case_id), mall: String(r.mall) as SaleEvent["mall"],
    kind: String(r.kind), name: String(r.name), startAt: String(r.start_at), endAt: String(r.end_at),
    presaleAt: r.presale_at == null ? null : String(r.presale_at),
    source: String(r.source) as SaleEvent["source"], confidence: String(r.confidence) as SaleEvent["confidence"],
    note: r.note == null ? null : String(r.note), participating: Number(r.participating) === 1,
    ...eventDays(String(r.start_at), String(r.end_at), r.presale_at == null ? null : String(r.presale_at)),
  }));
}

export async function saveEvent(
  db: D1Database,
  v: { id?: string; caseId?: string | null; mall?: string; kind?: string; name?: string; startAt?: string; endAt?: string;
    presaleAt?: string | null; confidence?: string; note?: string | null },
  by: string | null,
): Promise<string> {
  if (!v.name?.trim()) throw new Error("イベント名を入れてください");
  if (!["amazon", "rakuten"].includes(v.mall ?? "")) throw new Error("モールを選んでください");
  if (!valid(v.startAt) || !valid(v.endAt)) throw new Error("開始・終了の日時を入れてください");
  if (v.presaleAt && !valid(v.presaleAt)) throw new Error("先行セールの日時が正しくありません");
  if (v.endAt! < v.startAt!) throw new Error("終了が開始より前になっています");
  const conf = v.confidence === "estimated" ? "estimated" : "confirmed";
  if (v.id) {
    // 最初から登録してあるイベントも、日付と名前は直せる（日程が予想だったものを確定させるため）
    await db.prepare(
      `UPDATE sale_events SET mall = ?, kind = ?, name = ?, start_at = ?, end_at = ?, presale_at = ?, confidence = ?, note = ?,
              updated_by = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(v.mall, v.kind ?? "other", v.name.trim(), v.startAt, v.endAt, v.presaleAt || null, conf, v.note?.trim() || null, by, v.id).run();
    return v.id;
  }
  const id = `ev-m-${crypto.randomUUID()}`;
  await db.prepare(
    `INSERT INTO sale_events (id, case_id, mall, kind, name, start_at, end_at, presale_at, source, confidence, note, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`
  ).bind(id, v.caseId || null, v.mall, v.kind ?? "own", v.name.trim(), v.startAt, v.endAt, v.presaleAt || null, conf, v.note?.trim() || null, by).run();
  return id;
}

/** 手で登録したものだけ消せる。最初から登録してあるものは「参加しない」で外す */
export async function deleteEvent(db: D1Database, id: string): Promise<void> {
  const r = await db.prepare("SELECT source FROM sale_events WHERE id = ?").bind(id).first<{ source: string }>();
  if (!r) throw new Error("イベントが見つかりません");
  if (r.source !== "manual") throw new Error("最初から登録してあるイベントは消せません。「参加しない」にしてください");
  await db.batch([
    db.prepare("DELETE FROM case_event_participation WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM sale_events WHERE id = ?").bind(id),
  ]);
}

export async function setParticipation(db: D1Database, caseId: string, eventId: string, participating: boolean, by: string | null) {
  await db.prepare(
    `INSERT INTO case_event_participation (case_id, event_id, participating, updated_by, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(case_id, event_id) DO UPDATE SET participating = excluded.participating,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`
  ).bind(caseId, eventId, participating ? 1 : 0, by).run();
}
