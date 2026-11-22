import {api} from './api.js';
import {actions, canWrite, decisions, incidentStates, store, supervisor} from './store.js';
import {blank, esc, field, form, journal, nonce, notes, pill, portDate, selectField, timeInput, title} from './ui.js';

const features = {eta_offset_min: '引航偏离 / 分钟', tide_reserve_min: '潮窗余量 / 分钟', wind_kn: '现场风速 / kn', tug_wait_min: '拖轮等候 / 分钟'};

function caseIntake() {
  if (!canWrite()) return '';
  const eligible = store.data.requests.filter(r => r.state === 'confirmed' && !store.data.incidents.some(i => i.request_code === r.code));
  return `<details class="paper-fold"><summary>登记无线电事件</summary>${eligible.length ? form('report', '', `
    <div class="form-grid">${field('案件编号', 'code', 'text', '', 'placeholder="DL-414"')}
    ${selectField('已确认靠泊申请', 'request_code', eligible.map(r => [r.code, `${r.code} · ${r.vessel}`]))}
    ${field('VHF 记录号', 'radio_reference')}${field('观测时间', 'observed_at', 'datetime-local')}
    ${field('风速 / kn', 'wind_kn', 'number', '', 'step="0.1" min="0" max="65"')}
    ${field('拖轮等候 / 分钟', 'tug_wait_min', 'number', '', 'min="0" max="180"')}</div>${notes('现场事件', 'event_note', '记录引航或拖轮通报。')}`, '冻结输入并分类') : blank('暂无可登记的申请', '请先确认靠泊，同一申请只登记一条延误案件。')}</details>`;
}

function boundary(result) {
  if (!result) return '';
  const {score, band, prediction, metrics} = result;
  const extent = Math.max(1.2, Math.ceil(Math.abs(score) * 10 + 1) / 10);
  const left = (score / extent + 1) * 50;
  const signed = `${score >= 0 ? '+' : '−'}${Math.abs(score).toFixed(4)}`;
  return `<div class="boundary"><div class="section-head"><h3>模型决策分数 f(x)</h3><strong class="score mono">${signed}</strong></div>
  <div class="decision-chart" style="--pointer:${left}%;--half-band:${band * 50 / extent}%"><div class="axis"></div><div class="review-band"></div><div class="axis-center"></div><div class="score-pointer" title="${signed}"></div></div>
  <div class="axis-labels"><span>常规侧</span><b>±${band.toFixed(2)} 人工复核带</b><span>优先侧</span></div>
  <p class="model-note">模型建议 <strong>${esc(decisions[prediction])}</strong> · 合成验证集平衡准确率 ${(metrics.balanced_accuracy * 100).toFixed(1)}%</p>
  <details class="model-details"><summary>计算记录</summary><dl class="measurements"><div><dt>训练 / 验证</dt><dd>${metrics.train_rows} / ${metrics.validation_rows}</dd></div><div><dt>固定种子</dt><dd>${result.seed}</dd></div><div><dt>支持向量数</dt><dd>${metrics.support_vectors}</dd></div></dl><p class="digest">SHA-256 ${esc(result.input_digest)}</p></details></div>`;
}

function scoreText(value) {
  return value === null || value === undefined ? '—' : `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(4)}`;
}

export async function loadRetime(code) {
  store.retimeState = store.retimeState || {};
  if (store.retimeState[code] === 'loading') return store.retime[code];
  store.retimeState[code] = 'loading';
  try {
    store.retime[code] = await api.retimePreview(code);
  } catch (error) {
    store.error = error.message;
  } finally {
    store.retimeState[code] = 'idle';
  }
  return store.retime[code];
}

function candidateRows(preview) {
  return preview.candidates.map(row => {
    const status = row.feasible ? (row.returns_routine ? '可行 · 回常规区' : row.needs_review ? '可行 · 仍贴近边界' : '可行 · 未回常规区') : '不可排';
    const tag = row.recommended ? '<span class="pill ready">推荐</span>' : row.current ? '<span class="pill">当前</span>' : '';
    return `<tr class="${row.recommended ? 'active-row' : ''}"><td><strong class="mono">${esc(row.window_code)}</strong> ${tag}<small>${esc(portDate(row.eta))}–${esc(portDate(row.ends_at))}</small></td>
      <td>${esc(row.tide_reserve_min)} 分</td><td class="mono">${scoreText(row.score)}</td>
      <td>${row.feasible ? esc(row.tugs.join(' / ')) : esc(row.issues.join('；'))}</td><td>${esc(status)}</td></tr>`;
  }).join('');
}

function retimePanel(incident) {
  if (!['ready', 'actioned', 'closed'].includes(incident.state) || incident.decision !== 'priority') return '';
  const preview = store.retime[incident.code];
  if (incident.state !== 'ready' && !preview?.adoption) return '';
  const state = store.retimeState?.[incident.code];
  const open = supervisor() ? `<div class="section-head"><h2>改期预演</h2><button type="button" class="text-button" data-click="retime-preview" data-code="${esc(incident.code)}">${state === 'loading' ? '正在试排…' : preview ? '重新试排' : '试排潮窗'}</button></div>`
    : `<div class="section-head"><h2>改期预演</h2><span>只读</span></div>`;
  if (!preview) return `<section class="boundary retime">${open}<p class="model-note">${state === 'loading' ? '正在按原观测试排各潮窗…' : '只替换潮窗余量重新评分，泊位与拖轮仍按原计划保留，采纳前不占用任何资源。'}</p></section>`;
  if (state === 'loading') return `<section class="boundary retime">${open}<p class="model-note">正在按原观测试排各潮窗…</p></section>`;
  if (preview.adoption) {
    const a = preview.adoption;
    const review = store.data.reviews.find(r => r.incident_code === incident.code);
    return `<section class="boundary retime">${open}
      <p class="clearance">已采纳 <strong>${esc(a.from_window_code)} → ${esc(a.to_window_code)}</strong> · ${esc(a.from_tug_code)} → ${esc(a.to_tug_code)} · 余量 ${esc(a.tide_reserve_min)} 分 · f(x) ${scoreText(a.score)}。泊位与拖轮预约已同时切换，改期指令由 ${esc(a.adopted_by)} 于 ${esc(portDate(a.adopted_at))} 发布。</p>
      ${review ? `<p class="model-note">${esc(review.instruction)}</p>` : ''}
      ${a.candidates?.length ? `<p class="model-note">采纳时的候选分数：</p><div class="table-wrap"><table><thead><tr><th>候选潮窗</th><th>余量</th><th>f(x)</th><th>可用拖轮 / 排不下</th><th>结论</th></tr></thead><tbody>${candidateRows({candidates: a.candidates})}</tbody></table></div>` : ''}</section>`;
  }
  const recommended = preview.candidates.find(row => row.recommended);
  return `<section class="boundary retime">${open}
    <p class="model-note">冻结输入不变，仅替换潮窗余量；采纳前原泊位与拖轮预约照留。</p>
    <div class="table-wrap"><table><thead><tr><th>候选潮窗</th><th>余量</th><th>f(x)</th><th>可用拖轮 / 排不下</th><th>结论</th></tr></thead><tbody>${candidateRows(preview)}</tbody></table></div>
    ${recommended && supervisor() ? form('retime-adopt', incident.code, `<h3>采纳推荐方案</h3>
      <dl class="measurements"><div><dt>改到潮窗</dt><dd>${esc(recommended.window_code)}</dd></div><div><dt>操纵时段</dt><dd>${esc(portDate(recommended.eta))}–${esc(portDate(recommended.ends_at))}</dd></div><div><dt>拖轮</dt><dd>${esc(recommended.tugs[0] ?? '')}</dd></div></dl>
      ${notes('改期指令', 'instruction', '写明接收引航席、改期潮窗与拖轮安排。')}
      <input type="hidden" name="window_code" value="${esc(recommended.window_code)}">
      <input type="hidden" name="tug_code" value="${esc(recommended.tugs[0] ?? '')}">
      <input type="hidden" name="idempotency_key" value="${esc(nonce())}">`, '采纳改期并发布指令') : recommended ? '' : '<p class="warning">没有可同时排下泊位与拖轮的候选潮窗，请等待资源释放后重新试排。</p>'}</section>`;
}

function actionsFor(incident) {
  if (!supervisor()) return '';
  const code = incident.code;
  if (incident.state === 'failed') return form('retry', code, '', '按冻结输入重试');
  if (incident.state === 'margin_review') return form('verify', code, `
    <h3>人工确认分类</h3>${selectField('处置级别', 'decision', Object.entries(decisions))}
    ${notes('签署依据', 'reason', '例如已收到拖轮回转区的二次通报，需优先处置。')}`, '签署分类');
  if (incident.state === 'ready') {
    const choices = Object.entries(actions).filter(([key]) => incident.decision !== 'priority' || key !== 'monitor');
    return form('dispatch', code, `<h3>发布值班指令</h3>${selectField('调度动作', 'action', choices)}
      ${notes('交接指令', 'instruction', '填写接收岗位与下一步动作。')}`, '发布指令');
  }
  return '';
}

function incidentDetail(incident) {
  if (!incident) return blank('选择延误案件', '打开一条 VHF 记录，核对输入、模型分数及签署状态。');
  const request = store.data.requests.find(r => r.code === incident.request_code);
  const action = store.data.reviews.find(r => r.incident_code === incident.code);
  return `<header class="subhead"><div><div class="reference mono">${esc(incident.code)} / <a href="#schedule/${esc(request.code)}">${esc(request.code)}</a></div><h2>${esc(request.vessel)}</h2></div>${pill(incident.state, incidentStates)}</header>
    <p class="event-note"><span>${esc(incident.radio_reference)} · ${esc(portDate(incident.observed_at))}</span>${esc(incident.event_note)}</p>
    <dl class="feature-list">${Object.entries(features).map(([key, label]) => `<div><dt>${label}</dt><dd>${esc(incident.features[key])}</dd></div>`).join('')}</dl>
    ${incident.state === 'queued' ? '<p class="clearance" role="status">后台正在计算冻结观测，完成后自动更新。</p>' : ''}
    ${incident.error ? `<p class="warning">${esc(incident.error)}</p>` : ''}
    ${boundary(incident.result)}
    ${incident.state === 'margin_review' ? '<p class="warning">本案处于间隔带。签署分类前无法发布调度指令。</p>' : ''}
    ${incident.decision ? `<p class="clearance">${incident.decided_by ? `主管 ${esc(incident.decided_by)} 签署` : '分类结果'} · <strong>${esc(decisions[incident.decision])}</strong>${incident.decision_reason ? ` · ${esc(incident.decision_reason)}` : ''}</p>` : ''}
    ${retimePanel(incident)}${actionsFor(incident)}${action ? `<a class="quiet link-block" href="#reviews/${esc(incident.code)}">打开调度复盘 →</a>` : ''}`;
}

export function incidents(code) {
  const list = store.data.incidents;
  const active = list.find(i => i.code === code);
  return `${title('延误边界', '冻结无线电现场观测，复核贴近分类边界的案件。')}
  <div class="case-grid"><section class="panel case-inbox"><div class="section-head"><h2>案件队列</h2><span>${list.length} 件</span></div>
  ${list.length ? list.map(i => `<a class="queue-entry ${i.code === code ? 'selected-entry' : ''}" href="#incidents/${esc(i.code)}"><div><strong class="mono">${esc(i.code)}</strong>${pill(i.state, incidentStates)}</div><small>${esc(i.radio_reference)} · ${esc(portDate(i.observed_at))}</small></a>`).join('') : blank('尚无延误案件', '值班调度员可登记一条已确认申请的现场事件。')}${caseIntake()}</section>
  <section class="panel case-detail">${incidentDetail(active)}</section></div>`;
}

export function reviews(code) {
  const list = store.data.reviews;
  const record = list.find(r => r.incident_code === code);
  let detail = blank('选择一条已发布指令', '案件分类并发布指令后，可录入全缆系妥时刻及交班纪要。');
  if (record) {
    const incident = store.data.incidents.find(i => i.code === code);
    const request = store.data.requests.find(r => r.code === incident.request_code);
    detail = `<header class="subhead"><div><div class="reference mono">${esc(code)} / ${esc(request.code)}</div><h2>${esc(request.vessel)} · ${esc(actions[record.action])}</h2></div>${pill(incident.state, incidentStates)}</header>
      <p class="event-note"><span>发布人 ${esc(record.issued_by)} · 值班调度指令</span>${esc(record.instruction)}</p>
      <dl class="measurements"><div><dt>原计划引航</dt><dd>${esc(portDate(request.eta))}</dd></div><div><dt>延误观测</dt><dd>${esc(portDate(incident.observed_at))}</dd></div><div><dt>全缆系妥</dt><dd>${esc(portDate(record.all_fast_at))}</dd></div></dl>
      ${record.closed_at ? `<p class="clearance"><strong>结案人 ${esc(record.closed_by)}</strong> · ${esc(record.outcome)}</p>` : supervisor() ? form('close', code, `<h3>补登作业实绩</h3>${field('全缆系妥时刻', 'all_fast_at', 'datetime-local', '', `min="${esc(timeInput(incident.observed_at))}"`)}
        ${notes('复盘纪要', 'outcome', '写明指令执行结果、交接人及改进项。')}`, '保存实绩并结案') : '<p class="muted">等待主管补登作业实绩。</p>'}
      <h3>交接与核验记录</h3>${journal(store.history)}`;
  }
  return `${title('调度复盘', '把处置指令、现场实绩和交接原因留在同一案件。')}
  <div class="case-grid"><section class="panel case-inbox"><div class="section-head"><h2>指令簿</h2><span>${list.length} 件</span></div>
    ${list.map(r => `<a class="queue-entry ${code === r.incident_code ? 'selected-entry' : ''}" href="#reviews/${esc(r.incident_code)}"><div><strong class="mono">${esc(r.incident_code)}</strong>${pill(r.closed_at ? 'closed' : 'actioned', incidentStates)}</div><small>${esc(actions[r.action])} · ${esc(r.issued_by)}</small></a>`).join('') || blank('指令簿为空', '请从延误边界页发布首条调度指令。')}</section>
  <section class="panel case-detail">${detail}</section></div>`;
}
