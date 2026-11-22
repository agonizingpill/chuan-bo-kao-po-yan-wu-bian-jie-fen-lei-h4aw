"""Retime preview and adoption for priority delay cases.

The preview only reads the frozen observation and published tide windows: it
replaces the tide reserve feature with the reserve of every candidate window
and reports the resulting decision score. Nothing is reserved until a
supervisor adopts a candidate, and adoption switches the berth schedule and the
tug reservation together or not at all.
"""

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session as DatabaseSession

from . import classifier
from .models import (
    Action, Berth, BerthRequest, DelayClass, DelayIncident, DispatchReview,
    IncidentState, RequestState, RetimeAdoption, TideWindow, Tug, TugAssignment,
)
from .planning import Rejected, active_tug, audit, ends, find, require_window, utc_now


def _tug_conflict(db, eta, finish, tug_code, request_code):
    return db.scalar(select(TugAssignment).where(
        TugAssignment.tug_code == tug_code,
        TugAssignment.released_at.is_(None),
        TugAssignment.request_code != request_code,
        TugAssignment.starts_at < finish,
        TugAssignment.ends_at > eta,
    ).limit(1))


def _berth_conflict(db, berth_code, eta, finish, request_code):
    for other in db.scalars(select(BerthRequest).where(
        BerthRequest.berth_code == berth_code,
        BerthRequest.code != request_code,
        BerthRequest.state.in_([RequestState.CONFIRMED, RequestState.COMPLETED]),
        BerthRequest.eta < finish,
    )):
        if ends(other) > eta:
            return other
    return None


def _free_tugs(db, request, eta, finish, tugs):
    return [tug.code for tug in tugs if not _tug_conflict(db, eta, finish, tug.code, request.code)]


def _candidate_score(incident, reserve):
    features = dict(incident.features)
    features['tide_reserve_min'] = round(reserve, 3)
    return classifier.score(features)


def eligibility(incident, request):
    if incident.decision != DelayClass.PRIORITY:
        return False, '仅优先处置案件可以预演改期回常规区'
    if incident.state == IncidentState.MARGIN_REVIEW:
        return False, '案件仍在间隔带，请先由主管签署分类'
    if incident.state in (IncidentState.ACTIONED, IncidentState.CLOSED):
        return False, '案件已发布调度指令，改期预演不再适用'
    if incident.state != IncidentState.READY or not incident.decision:
        return False, '案件尚未完成分类，暂不能预演改期'
    if request.state != RequestState.CONFIRMED:
        return False, '关联申请不在已确认状态，无法预演改期'
    return True, None


def candidates(db: DatabaseSession, incident, request):
    """Trial-schedule every tide window of the berth with only the tide reserve replaced."""
    tugs = list(db.scalars(select(Tug).order_by(Tug.code)))
    windows = list(db.scalars(select(TideWindow).where(TideWindow.berth_code == request.berth_code)
                               .order_by(TideWindow.starts_at, TideWindow.code)))
    rows = []
    for window in windows:
        eta = max(request.eta, window.starts_at)
        finish = eta + timedelta(minutes=request.maneuver_minutes)
        reserve = (window.ends_at - finish).total_seconds() / 60
        issues = []
        if finish > window.ends_at:
            issues.append('操纵时段超出潮窗')
        if request.draft_m > window.max_draft_m:
            issues.append(f'申请吃水 {request.draft_m:g} m 超过限值 {window.max_draft_m:g} m')
        occupied = _berth_conflict(db, request.berth_code, eta, finish, request.code)
        if occupied:
            issues.append(f'泊位与 {occupied.code} 的操纵时段重叠')
        free = _free_tugs(db, request, eta, finish, tugs) if not issues else []
        if not issues and not free:
            issues.append('同泊位拖轮在该时段已排满')
        result = _candidate_score(incident, reserve)
        rows.append({
            'window_code': window.code, 'berth_code': window.berth_code,
            'window_starts_at': window.starts_at, 'window_ends_at': window.ends_at,
            'max_draft_m': window.max_draft_m, 'bulletin': window.bulletin,
            'eta': eta, 'ends_at': finish, 'maneuver_minutes': request.maneuver_minutes,
            'tide_reserve_min': round(reserve, 3),
            'current': window.code == request.window_code,
            'feasible': not issues, 'issues': issues, 'tugs': free,
            'score': round(result['score'], 6), 'band': result['band'],
            'prediction': result['prediction'], 'needs_review': result['needs_review'],
            'returns_routine': result['prediction'] == 'routine' and not result['needs_review'],
            'recommended': False,
        })
    rows.sort(key=lambda row: (row['eta'], row['window_starts_at'], row['window_code']))
    recommended = next((row for row in rows if row['feasible'] and row['returns_routine'] and not row['current']), None)
    if recommended:
        recommended['recommended'] = True
    return rows, recommended


def _snapshot(rows):
    """JSON-safe copy of the candidate list for the adoption record."""
    keys = ('window_code', 'berth_code', 'max_draft_m', 'bulletin', 'maneuver_minutes',
            'tide_reserve_min', 'current', 'feasible', 'issues', 'tugs', 'score', 'band',
            'prediction', 'needs_review', 'returns_routine', 'recommended')
    snap = []
    for row in rows:
        item = {key: row[key] for key in keys}
        item['eta'] = row['eta'].isoformat()
        item['ends_at'] = row['ends_at'].isoformat()
        item['window_starts_at'] = row['window_starts_at'].isoformat()
        item['window_ends_at'] = row['window_ends_at'].isoformat()
        snap.append(item)
    return snap


def adoption_view(adoption):
    if not adoption:
        return None
    return {
        'id': adoption.id, 'incident_code': adoption.incident_code, 'request_code': adoption.request_code,
        'from_window_code': adoption.from_window_code, 'to_window_code': adoption.to_window_code,
        'from_eta': adoption.from_eta, 'to_eta': adoption.to_eta,
        'maneuver_minutes': adoption.maneuver_minutes,
        'from_tug_code': adoption.from_tug_code, 'to_tug_code': adoption.to_tug_code,
        'tide_reserve_min': adoption.tide_reserve_min, 'score': adoption.score, 'band': adoption.band,
        'candidates': adoption.candidates or [],
        'adopted_by': adoption.adopted_by, 'adopted_at': adoption.adopted_at,
    }


def preview(db: DatabaseSession, incident):
    request = find(db, BerthRequest, incident.request_code)
    eligible, reason = eligibility(incident, request)
    rows, recommended = candidates(db, incident, request) if eligible else ([], None)
    reservation = active_tug(db, request.code)
    adoption = db.scalar(select(RetimeAdoption).where(RetimeAdoption.incident_code == incident.code))
    if not eligible and adoption and adoption.candidates:
        # Keep the scores that were visible when the candidate was adopted.
        rows = adoption.candidates
        recommended = next((row for row in rows if row.get('recommended')), None)
    return {
        'code': incident.code, 'request_code': request.code, 'eligible': eligible, 'reason': reason,
        'decision': incident.decision, 'state': incident.state, 'frozen': incident.features,
        'current': {
            'window_code': request.window_code, 'eta': request.eta, 'ends_at': ends(request),
            'maneuver_minutes': request.maneuver_minutes, 'tug_code': reservation.tug_code if reservation else None,
            'tide_reserve_min': incident.features.get('tide_reserve_min'),
            'score': (incident.result or {}).get('score'),
        },
        'candidates': rows, 'recommended_window': recommended['window_code'] if recommended else None,
        'adoption': adoption_view(adoption),
    }


def adopt(db: DatabaseSession, actor: str, code: str, data):
    incident = find(db, DelayIncident, code, lock=True)
    # Idempotent replay: a lost receipt must not retime or issue a second instruction.
    existing = db.scalar(select(RetimeAdoption).where(RetimeAdoption.idempotency_key == data.idempotency_key))
    if existing:
        if existing.incident_code != code:
            raise Rejected('IDEMPOTENCY_REUSED', '该回执编号已用于另一案件，请重新发起', code)
        review = find(db, DispatchReview, existing.incident_code)
        return existing, review, True
    prior = db.scalar(select(RetimeAdoption).where(RetimeAdoption.incident_code == code))
    if prior:
        raise Rejected('ALREADY_ADOPTED', f'案件已于 {prior.adopted_at:%m-%d %H:%M} 采纳改期方案', code)
    request = find(db, BerthRequest, incident.request_code, lock=True)
    eligible, reason = eligibility(incident, request)
    if not eligible:
        raise Rejected('RETIME_NOT_ELIGIBLE', reason, code)
    window = require_window(db, data.window_code, request.berth_code, code)
    reservation = active_tug(db, request.code)
    if not reservation:
        raise Rejected('TUG_REQUIRED', '关联申请缺少有效的拖轮预约', code)
    # Serialize against competing berth confirmations and tug reservations.
    find(db, Berth, request.berth_code, lock=True)
    for tug_code in sorted({reservation.tug_code, data.tug_code}):
        find(db, Tug, tug_code, lock=True)
    eta = max(request.eta, window.starts_at)
    finish = eta + timedelta(minutes=request.maneuver_minutes)
    reserve = (window.ends_at - finish).total_seconds() / 60
    if finish > window.ends_at:
        raise Rejected('RETIME_CONFLICT', f'{window.code} 无法覆盖整段操纵时段，请重新选择', code)
    if request.draft_m > window.max_draft_m:
        raise Rejected('RETIME_CONFLICT', f'申请吃水 {request.draft_m:g} m 超过 {window.code} 限值，请重新选择', code)
    occupied = _berth_conflict(db, request.berth_code, eta, finish, request.code)
    if occupied:
        raise Rejected('RETIME_CONFLICT', f'{request.berth_code} 已被 {occupied.code} 的操纵时段占用，请重新选择', code)
    clash = _tug_conflict(db, eta, finish, data.tug_code, request.code)
    if clash:
        raise Rejected('RETIME_CONFLICT', f'{data.tug_code} 已被 {clash.request_code} 的 {clash.starts_at:%H:%M}–{clash.ends_at:%H:%M} 占用，请重新选择', code)
    result = _candidate_score(incident, reserve)
    from_window, from_eta, from_tug = request.window_code, request.eta, reservation.tug_code
    snapshot = _snapshot(candidates(db, incident, request)[0])
    # Switch both bookings together, then issue the retime instruction in the same transaction.
    reservation.released_at = utc_now()
    db.add(TugAssignment(request_code=request.code, tug_code=data.tug_code, starts_at=eta, ends_at=finish))
    request.window_code = window.code
    request.eta = eta
    request.state = RequestState.CONFIRMED
    adoption = RetimeAdoption(
        idempotency_key=data.idempotency_key, incident_code=code, request_code=request.code,
        from_window_code=from_window, to_window_code=window.code, from_eta=from_eta, to_eta=eta,
        maneuver_minutes=request.maneuver_minutes, from_tug_code=from_tug, to_tug_code=data.tug_code,
        tide_reserve_min=round(reserve, 3), score=round(result['score'], 6), band=result['band'],
        candidates=snapshot, adopted_by=actor, adopted_at=utc_now(),
    )
    review = DispatchReview(incident_code=code, action=Action.RETIME, instruction=data.instruction,
                            issued_by=actor, issued_at=utc_now())
    db.add(adoption)
    db.add(review)
    incident.state = IncidentState.ACTIONED
    audit(db, actor, code, 'RETIME_ADOPTED',
          f'{from_window} {from_eta:%H:%M} → {window.code} {eta:%H:%M} · {from_tug} → {data.tug_code} · f(x)={result["score"]:+.4f}')
    audit(db, actor, code, 'ACTION_ISSUED', f'{Action.RETIME} · {data.instruction}')
    db.flush()
    return adoption, review, False
