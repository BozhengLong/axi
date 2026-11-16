"""新发布批次的持久控制账本。只管理授权与状态，不直接启动模型。"""
from pathlib import Path
import datetime as dt
import fcntl
import hashlib
import json
import os

MINUTE = 60
HOUR = 3600
PRODUCTS = ('v0', 'v1', 'claude')
ORDERS = (
    ('v0', 'v1', 'claude'), ('v1', 'claude', 'v0'),
    ('claude', 'v0', 'v1'), ('v0', 'claude', 'v1'),
    ('claude', 'v1', 'v0'), ('v1', 'v0', 'claude'),
)


class Refused(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def slots():
    rows = [{'id': 'health-' + p, 'kind': 'health', 'product': p, 'task': 'health', 'limit': 12} for p in PRODUCTS]
    rows += [{'id': x, 'kind': 'c7', 'product': 'v1', 'task': x, 'limit': 50} for x in ('C7-L', 'C7-O')]
    for n in range(1, 21):
        task = f'T{n:02}'
        rows += [{'id': task + '-' + p, 'kind': 'task', 'product': p, 'task': task, 'category': 'R' + str((n - 1) % 4 + 1), 'limit': 50} for p in ORDERS[(n - 1) % 6]]
    return rows


def new_state(authorization, identities):
    require(authorization['T1'] is None, '必须从未开始正式运行的新批次创建账本')
    t0 = timestamp(authorization['T0'])
    require(timestamp(authorization['preparationDeadline']) == t0 + 72 * HOUR, '准备截止不符')
    require(timestamp(authorization['absoluteDeadline']) == t0 + 168 * HOUR, '总截止不符')
    require(all(identities.get(x) for x in ('candidate', 'sourceHash', 'v0', 'image', 'model', 'claude')), '身份缺失')
    return {'T0': t0, 'preparationDeadline': t0 + 72 * HOUR, 'absoluteDeadline': t0 + 168 * HOUR,
            'identities': identities, 'T1': None, 'formalDeadline': None, 'phase': 'R2',
            'claims': {}, 'repair': None, 'paused': None, 'closure': None, 'manifest': None}


def assessed(state):
    return {key: value['review'] for key, value in state['claims'].items() if 'review' in value}


def decisive_failure(state):
    reviews = assessed(state)
    if any(r['classification'] == 'H' for r in reviews.values()):
        return 'confirmed-H'
    c7 = [reviews.get(x) for x in ('C7-L', 'C7-O')]
    if all(c7) and any(r['classification'] == 'N' for r in c7):
        return 'C7-below-2'
    task_reviews = [(s, reviews[s['id']]) for s in slots() if s['kind'] == 'task' and s['id'] in reviews]
    failed = [s for s, r in task_reviews if s['product'] == 'v1' and r['classification'] == 'N']
    if len(failed) >= 3 or any(sum(s['category'] == category for s in failed) >= 2 for category in ('R1', 'R2', 'R3', 'R4')):
        return 'G4-threshold-impossible'
    v1 = [(s, r) for s, r in task_reviews if s['product'] == 'v1']
    v0_success = sum(s['product'] == 'v0' and r['classification'] == 'PASS' for s, r in task_reviews)
    if sum(r['classification'] == 'PASS' for s, r in v1) + 20 - len(v1) < v0_success:
        return 'cannot-catch-v0'
    return None


def next_slot(state):
    require(not state['closure'] and not state['paused'], '全局关闭或暂停')
    reviews = assessed(state)
    require(all('review' in x for x in state['claims'].values()), '上一槽尚未封存和人工审查，禁止新启动')
    for slot in slots():
        if slot['id'] in state['claims']:
            continue
        if slot['kind'] == 'c7':
            require(all(reviews.get('health-' + p, {}).get('classification') == 'PASS' for p in PRODUCTS), '健康探针未全部通过')
        if slot['kind'] == 'task':
            require(all(reviews.get(x, {}).get('classification') == 'PASS' for x in ('C7-L', 'C7-O')), 'C7未完整通过')
            problem = decisive_failure(state)
            if problem:
                current = [s for s in slots() if s['kind'] == 'task' and s['task'] == slot['task'] and s['id'] in reviews]
                require(current, '已达提前停止条件，不能开始新组')
        return slot
    raise Refused('全部65槽已使用')


def remaining_window(state):
    """为全部尚未承诺的运行与审查留足上限，不依赖历史平均耗时。"""
    reviews = assessed(state)
    c7_failed = any(reviews.get(x, {}).get('classification') == 'N' for x in ('C7-L', 'C7-O'))
    outstanding = [s for s in slots() if s['id'] not in reviews and not (c7_failed and s['kind'] == 'task')]
    execution = sum((3 if s['kind'] == 'health' else 45) * MINUTE for s in outstanding)
    task_groups = len({s['task'] for s in outstanding if s['kind'] == 'task'})
    c7_review = 30 * MINUTE if any(s['kind'] == 'c7' for s in outstanding) else 0
    repair_reserve = 24 * HOUR if state['repair'] is None else 0
    return execution + task_groups * 30 * MINUTE + c7_review + repair_reserve + 3 * HOUR


def transition(state, action, payload, now):
    """所有状态转移以同一绝对时钟检查。调用者不可修改已写入的执行身份。"""
    state = json.loads(json.dumps(state))
    require(not state['closure'], '批次已经关闭')
    if action == 'freeze':
        require(state['phase'] == 'R2' and state['manifest'] is None and now <= state['preparationDeadline'], '准备窗口已结束')
        require(payload['identities'] == state['identities'], '冻结身份不符')
        require(payload['qualificationComplete'] is True and payload['remoteCommit'] == payload['commit'], '资格或推送未完成')
        require(len(payload['tasks']) == 20 and [t['id'] for t in payload['tasks']] == [f'T{i:02}' for i in range(1, 21)], '任务清单错误')
        require(all(t.get('admitted') is True and t.get('manifestHash') for t in payload['tasks']), '题目尚未完整准入')
        tasks = payload['tasks']
        require(all(t['category'] == 'R' + str(i % 4 + 1) for i, t in enumerate(tasks)), '四类交错槽改变')
        repositories = {t['repository'] for t in tasks}
        require(len(repositories) >= 8 and all(sum(t['repository'] == r for t in tasks) <= 3 for r in repositories), '仓库覆盖不足')
        require(sum(bool(t['userDirty']) for t in tasks) >= 10 and sum(bool(t['productionDirty']) for t in tasks) >= 4 and sum(bool(t['asyncBehavior']) for t in tasks) >= 8, '实际脏改或异步覆盖不足')
        require(all(payload.get(k) for k in ('engineeringHash', 'c7QualificationHash', 'controllerQualificationHash', 'facilityHash', 'dependencyHash', 'evidenceAuditHash')), '完整资格证据缺失')
        state['manifest'] = payload
    elif action == 'begin':
        require(state['phase'] == 'R2' and state['manifest'] and state['T1'] is None, '未冻结或重复开始')
        require(now <= state['preparationDeadline'], '不能在准备截止后启动T1')
        state.update(T1=now, formalDeadline=min(now + 96 * HOUR, state['absoluteDeadline']), phase='R3')
        require(now + remaining_window(state) + 2 * HOUR <= state['formalDeadline'], '全部承诺窗口和启动预留放不下')
    elif action == 'claim':
        require(state['T1'] is not None, '真实运行尚未准入')
        require(payload['identities'] == state['identities'] and payload['manifestHash'] == digest(state['manifest']), '启动身份不符')
        require(payload['facilityHash'] == (state['repair']['facilityHash'] if state['repair'] and state['repair'].get('completedAt') else state['manifest']['facilityHash']), '评分设施不符')
        require(now + remaining_window(state) <= state['formalDeadline'], '剩余计划/修复/报告时间不足')
        slot = next_slot(state)
        require(payload['id'] == slot['id'], '顺序错误或槽已claim')
        require(payload['requestLimit'] == slot['limit'], '每槽请求上限改变')
        require(len(state['claims']) < 65, 'CLI总数超限')
        spent = sum(x.get('seal', {}).get('forwardedGeneration', 0) for x in state['claims'].values())
        require(spent + slot['limit'] <= 3136, '生成请求总额不足')
        state['claims'][slot['id']] = {'slot': slot, 'claimedAt': now, 'launch': None,
                                     'executionDeadline': min(now + (3 if slot['kind'] == 'health' else 30) * MINUTE, state['formalDeadline'] - 3 * HOUR)}
        state['phase'] = {'health': 'R3', 'c7': 'R4', 'task': 'R5'}[slot['kind']]
    elif action == 'launched':
        require(not state['paused'], '全局暂停后不能启动已claim的槽')
        claim = state['claims'][payload['id']]
        require(claim['launch'] is None and 'seal' not in claim, '禁止重复启动已claim的槽')
        require(now < claim['executionDeadline'] and payload.get('processIdentity'), '启动超时或进程身份缺失')
        claim['launch'] = payload
    elif action == 'seal':
        claim = state['claims'][payload['id']]
        require(claim['launch'] is not None and 'seal' not in claim, '未启动或重复封存')
        require(payload['candidate'] == state['identities']['candidate'], '产物候选身份不符')
        require(payload['writersClosed'] is True and payload['manifestVerified'] is True, '写入者未停止或Trace哈希失败')
        require(all(payload.get(k) for k in ('traceHash', 'artifactHash', 'executionHash', 'cleanupHash')), '证据不全')
        require(0 <= payload['forwardedGeneration'] <= claim['slot']['limit'], '实际转发的生成请求超额')
        require(payload['receivedAttempts'] >= payload['forwardedGeneration'] and payload['countTokens'] >= 0, '请求计数口径混用')
        require(claim['claimedAt'] <= payload['endedAt'] <= min(now, claim['executionDeadline']), '执行时间超限，须暂停调查')
        require(payload['gradeSeconds'] <= 15 * MINUTE and payload['gradeSeconds'] >= 0, '最终/检查点评分共享窗口超限')
        views = payload['views']
        require(len(views) in (1, 2) and len({v['id'] for v in views}) == len(views), '封存视图重复或超限')
        require(views[0] == {'id': payload['id'] + '/final', 'kind': 'final', 'artifactHash': payload['artifactHash']}, '最终视图未绑定')
        if len(views) == 2:
            require(claim['slot']['product'] == 'v1' and claim['slot']['kind'] != 'health', '该槽不应有复核检查点')
            require(views[1]['id'] == payload['id'] + '/checkpoint' and views[1]['kind'] == 'checkpoint' and views[1].get('artifactHash'), '检查点未绑定')
        claim['seal'] = payload
    elif action == 'review':
        claim = state['claims'][payload['id']]
        require('seal' in claim and 'review' not in claim, '必须先封存且不能覆盖旧审查')
        require(payload['artifactHash'] == claim['seal']['artifactHash'] and payload['executionHash'] == claim['seal']['executionHash'], '人工审查未绑定产物')
        require(payload.get('gradeHash') and payload.get('reviewEvidenceHash') and payload.get('reviewer'), '审查依据缺失')
        require(payload['classification'] in ('PASS', 'N', 'H', 'UNKNOWN'), '未知判据')
        if payload['classification'] == 'H':
            require(payload.get('criticalClause') and payload.get('violationEvidenceHash'), 'H必须有实际违约证据，不能仅依赖测试名称')
        claim['review'] = payload
        if payload['classification'] == 'H':
            state['paused'] = {'reason': 'confirmed-H', 'slot': payload['id'], 'at': now}
        elif payload['classification'] == 'UNKNOWN':
            state['paused'] = {'reason': 'untrusted-evidence', 'slot': payload['id'], 'at': now}
        elif claim['slot']['kind'] == 'health' and payload['classification'] != 'PASS':
            state['paused'] = {'reason': 'health-failed', 'slot': payload['id'], 'at': now}
    elif action == 'pause':
        require(payload.get('incident') and payload.get('evidenceHash'), '暂停原因必须留证')
        state['paused'] = {**payload, 'at': now}
    elif action == 'repair-begin':
        require(state['paused'] and state['repair'] is None, '仅允许一次全局暂停后的修复')
        require(payload['sameContract'] is True and payload['identities'] == state['identities'], '修复改变契约或产品')
        require(state['paused']['reason'] not in ('confirmed-H', 'health-failed'), '本事件不属于可修复评分设施')
        require(payload['contractsHash'] == digest(state['manifest']['tasks']), '任务输入或契约改变')
        views = payload['affectedViews']
        require(len(views) <= 84 and len(views) == len(set(views)), '受影响视图重复或超限')
        require(payload['scope'] in ('shared', 'tasks'), '未知修复影响范围')
        require(payload['scope'] == 'shared' or payload.get('scopeTasks'), '局部修复必须列出影响任务')
        expected = [v['id'] for c in state['claims'].values() if 'seal' in c and c['slot']['kind'] != 'health' and (payload['scope'] == 'shared' or c['slot']['task'] in payload['scopeTasks']) for v in c['seal']['views']]
        require(sorted(views) == sorted(expected), '修复未覆盖范围内全部封存视图，或引用不存在的视图')
        require(payload.get('impactAuditHash') and payload.get('reproductionHash'), '影响审计和复现缺失')
        require(0 < payload['estimateSeconds'] <= 24 * HOUR, '修复估时无效')
        require(now + payload['estimateSeconds'] <= state['formalDeadline'] - 3 * HOUR, '修复与重评放不下')
        state['repair'] = {**payload, 'startedAt': now, 'deadline': min(now + 24 * HOUR, state['formalDeadline'] - 3 * HOUR)}
    elif action == 'repair-complete':
        repair = state['repair']
        require(repair and not repair.get('completedAt') and state['paused'], '修复状态错误')
        require(now <= repair['deadline'], '修复超时')
        require(payload['contractsHash'] == repair['contractsHash'] and payload['identities'] == state['identities'], '恢复时契约或产品改变')
        require(sorted(payload['regradedViews']) == sorted(repair['affectedViews']), '没有完整重评受影响视图')
        require(payload['repeats'] == 5 and payload['qualificationPassed'] is True, '受影响五次资格未通过')
        require(all(payload.get(k) for k in ('qualificationHash', 'regradeAuditHash', 'oldGradesHash', 'facilityHash', 'cleanupHash')), '恢复证据缺失')
        affected_slots = {v.split('/')[0] for v in repair['affectedViews']}
        corrections = payload['reviews']
        require(len(corrections) == len(affected_slots) and {r['id'] for r in corrections} == affected_slots, '全部受影响槽必须统一重新审查')
        new_pause = None
        for review in corrections:
            claim = state['claims'][review['id']]
            require(review['artifactHash'] == claim['seal']['artifactHash'] and review['executionHash'] == claim['seal']['executionHash'], '重审不能替换执行产物')
            require(review['classification'] in ('PASS', 'N', 'H', 'UNKNOWN'), '重审判据无效')
            require(all(review.get(k) for k in ('gradeHash', 'reviewEvidenceHash', 'reviewer')), '重审证据缺失')
            if review['classification'] == 'H':
                require(review.get('criticalClause') and review.get('violationEvidenceHash'), '新H须有实际违约证据')
                new_pause = {'reason': 'confirmed-H', 'slot': review['id'], 'at': now}
            elif review['classification'] == 'UNKNOWN' and new_pause is None:
                new_pause = {'reason': 'untrusted-evidence', 'slot': review['id'], 'at': now}
            if 'review' in claim:
                claim.setdefault('reviewHistory', []).append(claim['review'])
            claim['review'] = review
        repair.update(payload, completedAt=now)
        # 局部重评不能清除其他槽尚未解决的H/UNKNOWN，全局暂停由全部审查决定。
        for slot_id, claim in state['claims'].items():
            classification = claim.get('review', {}).get('classification')
            if classification == 'H':
                new_pause = {'reason': 'confirmed-H', 'slot': slot_id, 'at': now}
                break
            if classification == 'UNKNOWN' and new_pause is None:
                new_pause = {'reason': 'untrusted-evidence', 'slot': slot_id, 'at': now}
        state['paused'] = new_pause
    elif action == 'close':
        problem = decisive_failure(state)
        failures = payload.get('requiredGateFailures', [])
        require(all(f.get('gate') in ('G0','G1','G2','G3','G4','G5','G6') and f.get('evidenceHash') for f in failures), '必要门槛失败必须有既定ID和证据')
        if failures and problem is None:
            problem = 'required-gate-failure'
        reviews = assessed(state)
        required = {x['id'] for x in slots()}
        complete = required == set(reviews) and all(x['classification'] in ('PASS', 'N') for x in reviews.values())
        verdict = 'NO-GO' if problem else ('GO' if complete and payload.get('allGatesPassed') is True else 'INCOMPLETE')
        require(payload['verdict'] == verdict, '结论不符合证据')
        require(payload.get('reportHash') and payload.get('cleanupHash'), '关闭必须有报告和清理记录')
        state['closure'] = {**payload, 'at': now, 'decisiveFailure': problem}
        state['phase'] = 'R6'
    else:
        raise Refused('未定义的操作')
    return state


class Ledger:
    """flock串行化，fsync追加哈希链；重启只重建状态，不补启动旧claim。"""
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(exist_ok=True)
        self.path = self.directory / 'controller-events.jsonl'

    def apply(self, action, payload, now=None):
        now = dt.datetime.now(dt.timezone.utc).timestamp() if now is None else now
        with (self.directory / 'controller.lock').open('a+b') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            rows = []
            if self.path.exists():
                raw = self.path.read_bytes()
                require(not raw or raw.endswith(b'\n'), '账本末行不完整，禁止猜测恢复')
                for line in raw.splitlines():
                    row = json.loads(line)
                    checksum = row.pop('hash')
                    require(digest(row) == checksum and row['previous'] == (rows[-1]['hash'] if rows else None), '账本哈希链损坏')
                    row['hash'] = checksum
                    require(row['sequence'] == len(rows), '账本顺序损坏')
                    rows.append(row)
            require(not rows or now >= rows[-1]['at'], '系统时钟倒退，暂停核对绝对截止')
            if action == 'initialize':
                require(not rows, '不能覆盖或重置已有账本')
                state = new_state(payload['authorization'], payload['identities'])
            else:
                require(rows, '账本未初始化')
                state = transition(rows[-1]['state'], action, payload, now)
            row = {'sequence': len(rows), 'previous': rows[-1]['hash'] if rows else None,
                   'at': now, 'action': action, 'payload': payload, 'state': state}
            row['hash'] = digest(row)
            with self.path.open('ab') as output:
                output.write(canonical(row) + b'\n')
                output.flush()
                os.fsync(output.fileno())
            directory_fd = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
            return state
