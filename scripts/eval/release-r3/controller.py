"""R3持久控制状态：固定时间、独立attempt、可审计的有限外部恢复。"""
from pathlib import Path
import datetime as dt
import fcntl
import hashlib
import json
import os

MINUTE = 60
HOUR = 3600
PRODUCTS = ('v0', 'v1', 'claude')
ORDERS = (('v0', 'v1', 'claude'), ('v1', 'claude', 'v0'), ('claude', 'v0', 'v1'),
          ('v0', 'claude', 'v1'), ('claude', 'v1', 'v0'), ('v1', 'v0', 'claude'))


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
    rows = [dict(id='health-' + p, kind='health', product=p, task='health') for p in PRODUCTS]
    rows += [dict(id=t, kind='c7', product='v1', task=t) for t in ('C7-L', 'C7-O')]
    for n in range(1, 21):
        task = f'U{n:02}'
        rows += [dict(id=task + '-' + p, kind='task', product=p, task=task, category='R' + str((n-1) % 4+1)) for p in ORDERS[(n-1) % 6]]
    return rows


def new_state(authorization, identities):
    t0 = timestamp(authorization['T0'])
    require(authorization['T1'] is None and authorization['maximumRealCli'] == 73, '必须使用新的R3授权')
    require(authorization['limitMode'] == 'unlimited' and authorization['requestLimit'] is None, '请求策略不符')
    require(timestamp(authorization['preparationDeadline']) == t0 + 72*HOUR and timestamp(authorization['absoluteDeadline']) == t0 + 168*HOUR, '绝对时钟不符')
    require(all(identities.get(k) for k in ('candidate', 'sourceHash', 'v0', 'image', 'model', 'claude')), '冻结身份缺失')
    return dict(schema=3, T0=t0, preparationDeadline=t0+72*HOUR, absoluteDeadline=t0+168*HOUR,
                identities=identities, T1=None, formalDeadline=None, phase='R0', manifest=None,
                claims={}, paused=None, repair=None, recoveries=[], activeRecovery=None, closure=None)


def assessed(state):
    # 只选择第一份可判PASS/N的尝试。ENV/UNKNOWN既不冒充N，也不删分母。
    result = {}
    for claim in state['claims'].values():
        review = claim.get('review', {})
        if claim['slot']['kind'] != 'recovery-health' and review.get('classification') in ('PASS', 'N'):
            result.setdefault(claim['logicalId'], review)
    return result


def decisive_failure(state):
    claims = state['claims'].values()
    if any(c.get('review', {}).get('classification') == 'H' for c in claims):
        return 'confirmed-H'
    if any(c['slot']['kind'] in ('health', 'recovery-health') and c.get('review', {}).get('classification') == 'N' for c in claims):
        return 'health-failed'
    reviews = assessed(state)
    if all(x in reviews for x in ('C7-L', 'C7-O')) and any(reviews[x]['classification'] == 'N' for x in ('C7-L', 'C7-O')):
        return 'C7-below-2'
    failures = [s for s in slots() if s['kind'] == 'task' and s['product'] == 'v1' and reviews.get(s['id'], {}).get('classification') == 'N']
    if len(failures) >= 3 or any(sum(s['category'] == category for s in failures) >= 2 for category in ('R1', 'R2', 'R3', 'R4')):
        return 'G4-threshold-impossible'
    v1 = [r for key, r in reviews.items() if key.startswith('U') and key.endswith('-v1')]
    v0_success = sum(key.startswith('U') and key.endswith('-v0') and r['classification'] == 'PASS' for key, r in reviews.items())
    if sum(r['classification'] == 'PASS' for r in v1) + 20 - len(v1) < v0_success:
        return 'cannot-catch-v0'
    return None


def active_recovery(state):
    return None if state['activeRecovery'] is None else state['recoveries'][state['activeRecovery']]


def attempt_slot(slot, attempt=1, recovery=None):
    return {**slot, 'logicalId': slot['id'], 'id': slot['id'] + '-a' + str(attempt), 'attempt': attempt, 'recovery': recovery}


def next_slot(state, now):
    require(not state['closure'], '批次已关闭')
    require(all('review' in c for c in state['claims'].values()), '上一尝试尚未封存和审查')
    recovery = active_recovery(state)
    if recovery:
        require(not recovery.get('failed') and now <= recovery['deadline'], '恢复失败或恢复准入截止')
        require(now >= recovery['cooldownUntil'], '固定冷却尚未结束')
        target = state['claims'][recovery['target']]
        for product in PRODUCTS:
            if target['slot']['kind'] == 'health' and target['slot']['product'] == product:
                slot = attempt_slot(target['slot'], 2, state['activeRecovery'])
            else:
                base = dict(id=f'recovery-{recovery["number"]}-health-{product}', kind='recovery-health', product=product, task='health')
                slot = attempt_slot(base, 1, state['activeRecovery'])
            if slot['id'] not in state['claims']:
                return slot
            review = state['claims'][slot['id']]['review']
            require(review['classification'] == 'PASS' and review.get('cleanUpstream') is True, '恢复健康检查不合格')
        require(target['slot']['kind'] != 'health', '健康目标已由恢复轮补齐')
        return attempt_slot(target['slot'], 2, state['activeRecovery'])
    require(not state['paused'], '全局暂停')
    reviews = assessed(state)
    for slot in slots():
        if slot['id'] in reviews:
            continue
        require(not any(c['logicalId'] == slot['id'] for c in state['claims'].values()), '未决尝试不能隐式重跑')
        if slot['kind'] == 'c7':
            require(all(reviews.get('health-' + p, {}).get('classification') == 'PASS' for p in PRODUCTS), '健康探针未通过')
        if slot['kind'] == 'task':
            require(all(reviews.get(x, {}).get('classification') == 'PASS' for x in ('C7-L', 'C7-O')), 'C7未完整2/2')
            if decisive_failure(state):
                require(any(s['task'] == slot['task'] and s['id'] in reviews for s in slots()), '已达到提前停止条件')
        return attempt_slot(slot)
    raise Refused('全部65个逻辑槽已完成')


def remaining_window(state, now):
    reviews = assessed(state)
    pending = [s for s in slots() if s['id'] not in reviews]
    execution = sum((8 if s['kind'] == 'health' else 45)*MINUTE for s in pending)
    review = len({s['task'] for s in pending if s['kind'] == 'task'})*30*MINUTE
    review += 30*MINUTE if any(s['kind'] == 'c7' for s in pending) else 0
    recovery = (2-len(state['recoveries']))*135*MINUTE
    active = active_recovery(state)
    if active:
        # 目标补跑已经包含在pending，避免再次计算45分钟。
        recovery += max(0, active['deadline']-now)+30*MINUTE
    return execution+review+recovery+(24*HOUR if state['repair'] is None else 0)+3*HOUR


def update_recovery(state, claim, now):
    recovery = active_recovery(state)
    if not recovery or claim.get('recovery') != state['activeRecovery']:
        return
    review = claim['review']
    target = state['claims'][recovery['target']]
    is_probe = claim['slot']['kind'] in ('health', 'recovery-health')
    if is_probe and (review['classification'] != 'PASS' or review.get('cleanUpstream') is not True):
        recovery['failed'] = True;state['paused'] = dict(reason='recovery-health-failed', slot=claim['id'], at=now);return
    if not is_probe:
        if review['classification'] in ('PASS', 'N'):
            recovery['completedAt'] = now;state['activeRecovery'] = None;state['paused'] = None
        else:
            recovery['failed'] = True;state['paused'] = dict(reason='recovery-attempt-failed', slot=claim['id'], at=now)
    elif target['slot']['kind'] == 'health':
        done = []
        for product in PRODUCTS:
            logical = target['logicalId'] if product == target['slot']['product'] else f'recovery-{recovery["number"]}-health-{product}'
            matches = [c for c in state['claims'].values() if c['logicalId'] == logical and c.get('recovery') == state['activeRecovery']]
            done.append(bool(matches) and matches[-1].get('review', {}).get('classification') == 'PASS' and matches[-1]['review'].get('cleanUpstream') is True)
        if all(done):
            recovery['completedAt'] = now;state['activeRecovery'] = None;state['paused'] = None


def transition(state, action, payload, now):
    state = json.loads(json.dumps(state))
    require(not state['closure'], '批次已经关闭')
    if action == 'freeze':
        require(state['manifest'] is None and state['T1'] is None and now <= state['preparationDeadline'], '准备截止或已经冻结')
        require(payload['identities'] == state['identities'] and payload['qualificationComplete'] is True and payload['remoteCommit'] == payload['commit'], '冻结身份、资格或推送不符')
        require(payload['executionPolicy'] == {'version': 'r3', 'limitMode': 'unlimited', 'requestLimit': None}, '运行策略不符')
        tasks = payload['tasks']
        require(len(tasks) == 20 and [t['id'] for t in tasks] == [f'U{i:02}' for i in range(1, 21)], '任务槽不符')
        require(all(t.get('admitted') is True and t.get('manifestHash') and t['category'] == 'R'+str(i % 4+1) for i, t in enumerate(tasks)), '任务资格或类别不符')
        repositories = {t['repository'] for t in tasks}
        require(len(repositories) >= 8 and all(sum(t['repository'] == r for t in tasks) <= 3 for r in repositories), '仓库覆盖不足')
        require(sum(t['userDirty'] is True for t in tasks) >= 10 and sum(t['productionDirty'] is True for t in tasks) >= 4 and sum(t['asyncBehavior'] is True for t in tasks) >= 8, '脏改或异步覆盖不足')
        require(all(payload.get(k) for k in ('engineeringHash', 'c7QualificationHash', 'controllerQualificationHash', 'facilityHash', 'dependencyHash', 'evidenceAuditHash', 'reuseAuditHash')), '资格证明缺失')
        state['manifest'] = payload;state['phase']='R2'
    elif action == 'begin':
        require(state['manifest'] and state['T1'] is None and now <= state['preparationDeadline'], '尚未准入或准备过期')
        state.update(T1=now, formalDeadline=min(now+96*HOUR, state['absoluteDeadline']), phase='R3')
        require(now+remaining_window(state, now)+2*HOUR <= state['formalDeadline'], '全部承诺窗口放不下')
    elif action == 'claim':
        require(state['T1'] is not None, '真实运行尚未准入')
        require(payload['identities'] == state['identities'] and payload['manifestHash'] == digest(state['manifest']), '启动身份不符')
        facility = state['repair']['facilityHash'] if state['repair'] and state['repair'].get('completedAt') else state['manifest']['facilityHash']
        require(payload['facilityHash'] == facility and payload['requestLimit'] is None and payload['limitMode'] == 'unlimited', '设施或策略不符')
        require(now+remaining_window(state, now) <= state['formalDeadline'], '剩余窗口不足')
        slot = next_slot(state, now)
        require(payload['id'] == slot['id'] and payload['attempt'] == slot['attempt'], '顺序或尝试编号错误')
        require(slot['id'] not in state['claims'] and len(state['claims']) < 73, '重复claim或超过73次')
        state['claims'][slot['id']] = dict(id=slot['id'], logicalId=slot['logicalId'], attempt=slot['attempt'], recovery=slot['recovery'], slot={**{k:v for k,v in slot.items() if k not in ('attempt', 'recovery', 'logicalId')}, 'id':slot['logicalId']}, claimedAt=now, launch=None, executionDeadline=now+(3 if slot['kind'] in ('health','recovery-health') else 30)*MINUTE)
        state['phase'] = {'health':'R3','recovery-health':state['phase'],'c7':'R4','task':'R5'}[slot['kind']]
    elif action == 'launched':
        claim = state['claims'][payload['id']]
        require(not state['paused'] or claim.get('recovery') == state['activeRecovery'] and state['activeRecovery'] is not None, '暂停后禁止启动')
        require(claim['launch'] is None and 'seal' not in claim and now < claim['executionDeadline'] and payload.get('processIdentity'), '重复启动、超时或缺进程身份')
        claim['launch'] = {**payload, 'at': now}
    elif action == 'seal':
        claim = state['claims'][payload['id']]
        require(claim['launch'] is not None and 'seal' not in claim, '未启动或重复封存')
        require(payload['candidate'] == state['identities']['candidate'] and payload['writersClosed'] is True and payload['manifestVerified'] is True, '封存身份/写入者不符')
        require(all(payload.get(k) for k in ('traceHash','artifactHash','executionHash','cleanupHash')), '证据缺失')
        require(all(type(payload[k]) is int and payload[k]>=0 for k in ('forwardedGeneration','receivedAttempts','countTokens')) and payload['receivedAttempts'] >= payload['forwardedGeneration'], '计数口径不符')
        require(claim['claimedAt'] <= payload['endedAt'] <= min(now, claim['executionDeadline']+5), '执行超出截止和5秒收束')
        if payload['endedAt'] > claim['executionDeadline']:
            require(payload.get('termination') == 'deadline' and payload.get('deadlineEnforced') is True, '不能把迟到正常完成当通过')
        grade_limit = (5 if claim['slot']['kind'] in ('health','recovery-health') else 15)*MINUTE
        require(0 <= payload['gradeSeconds'] <= grade_limit and now <= min(payload['endedAt'], claim['executionDeadline'])+grade_limit, '评分/封存共享窗口超限')
        views = payload['views'];require(1 <= len(views) <= 2 and len({v['id'] for v in views}) == len(views), '封存视图错误')
        require(views[0] == {'id':payload['id']+'/final','kind':'final','artifactHash':payload['artifactHash']}, '最终视图未绑定')
        if len(views) == 2:
            require(claim['slot']['product'] == 'v1' and views[1]['id'] == payload['id']+'/checkpoint' and views[1]['kind'] == 'checkpoint' and views[1].get('artifactHash'), '检查点未绑定')
        claim['seal'] = payload
    elif action == 'review':
        claim = state['claims'][payload['id']]
        require('seal' in claim and 'review' not in claim, '必须先封存，不能覆盖旧审查')
        require(payload['artifactHash'] == claim['seal']['artifactHash'] and payload['executionHash'] == claim['seal']['executionHash'], '审查未绑定执行')
        require(all(payload.get(k) for k in ('gradeHash','reviewEvidenceHash','reviewer')), '审查证据缺失')
        require(payload['classification'] in ('PASS','N','H','UNKNOWN','ENV_INTERRUPTED'), '未知分类')
        if payload['classification'] == 'PASS':
            require(claim['seal'].get('termination') == 'completed' and payload.get('allChecksPassed') is True, '未完成或未通过不能判PASS')
        if payload['classification'] == 'H':
            require(payload.get('criticalClause') and payload.get('violationEvidenceHash'), 'H缺少违约见证')
        if payload['classification'] == 'ENV_INTERRUPTED':
            require(payload.get('externalCauseConfirmed') is True and payload.get('externalEvidenceHash') and payload.get('protectionReviewed') is True and payload.get('confirmedH') is False, '外部中断缺少直接证据或保护审查')
            require(claim['seal'].get('termination') in ('retry_exhausted','upstream_interrupted','deadline'), '正常完成或普通失败不得改称外部中断')
        claim['review'] = payload
        if payload['classification'] in ('H','UNKNOWN','ENV_INTERRUPTED'):
            state['paused'] = dict(reason={'H':'confirmed-H','UNKNOWN':'untrusted-evidence','ENV_INTERRUPTED':'environment'}[payload['classification']], slot=payload['id'], at=now)
        elif claim['slot']['kind'] in ('health','recovery-health') and payload['classification'] == 'N':
            state['paused'] = dict(reason='health-failed', slot=payload['id'], at=now)
        update_recovery(state, claim, now)
    elif action == 'environment-begin':
        require(state['paused'] and state['paused']['reason'] == 'environment' and state['activeRecovery'] is None, '不是可恢复的外部事件')
        require(len(state['recoveries']) < 2 and payload['target'] == state['paused']['slot'], '超过两次恢复或目标不符')
        claim = state['claims'][payload['target']]
        require(claim['attempt'] == 1 and claim['slot']['kind'] != 'recovery-health' and claim['review']['classification'] == 'ENV_INTERRUPTED', '该槽不能再次重跑')
        require(payload.get('incidentHash') and payload['externalEvidenceHash'] == claim['review']['externalEvidenceHash'], '恢复没有绑定事件证据')
        require(now+remaining_window(state, now) <= state['formalDeadline'], '恢复及剩余工作放不下')
        event = dict(number=len(state['recoveries'])+1, target=payload['target'], incidentHash=payload['incidentHash'], externalEvidenceHash=payload['externalEvidenceHash'], startedAt=now, cooldownUntil=now+15*MINUTE, deadline=now+HOUR)
        state['activeRecovery'] = len(state['recoveries']);state['recoveries'].append(event)
    elif action == 'pause':
        require(payload.get('incident') and payload.get('evidenceHash') and payload.get('reason') in ('measurement','resource','untrusted-evidence'), '暂停原因无效')
        require(not decisive_failure(state) and state['activeRecovery'] is None, '不能覆盖H或恢复中的停止原因')
        state['paused'] = {**payload,'at':now}
    elif action == 'repair-begin':
        require(state['paused'] and state['paused']['reason'] in ('measurement','untrusted-evidence') and state['activeRecovery'] is None and state['repair'] is None, '仅允许一次全局暂停后的修复')
        require(payload['sameContract'] is True and payload['identities'] == state['identities'], '修复改变契约或产品')
        require(state['paused']['reason'] not in ('confirmed-H', 'health-failed'), '本事件不属于可修复评分设施')
        require(payload['contractsHash'] == digest(state['manifest']['tasks']), '任务输入或契约改变')
        views = payload['affectedViews']
        require(len(views) <= 100 and len(views) == len(set(views)), '受影响视图重复或超限')
        require(payload['scope'] in ('shared', 'tasks'), '未知修复影响范围')
        require(payload['scope'] == 'shared' or payload.get('scopeTasks'), '局部修复必须列出影响任务')
        expected = [v['id'] for c in state['claims'].values() if 'seal' in c and (payload['scope'] == 'shared' or c['slot']['task'] in payload['scopeTasks']) for v in c['seal']['views']]
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
            require(review['classification'] in ('PASS', 'N', 'H', 'UNKNOWN', 'ENV_INTERRUPTED'), '重审判据无效')
            previous = claim.get('review', {})
            if review['classification'] == 'ENV_INTERRUPTED':
                require(previous.get('classification') == 'ENV_INTERRUPTED' and review.get('externalEvidenceHash') == previous.get('externalEvidenceHash'), '评分修复不能把普通失败改为可重跑外部中断')
            if previous.get('classification') == 'ENV_INTERRUPTED':
                require(review['classification'] in ('ENV_INTERRUPTED','H','UNKNOWN'), '不能把中断产物重评为正常交付')
            if review['classification'] == 'PASS':
                require(claim['seal'].get('termination') == 'completed' and review.get('allChecksPassed') is True, '重审PASS缺少完成与检查证据')
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
            if classification in ('UNKNOWN','ENV_INTERRUPTED') and new_pause is None:
                new_pause = {'reason': 'untrusted-evidence' if classification=='UNKNOWN' else 'environment', 'slot': slot_id, 'at': now}
        state['paused'] = new_pause
    elif action == 'close':
        problem = decisive_failure(state);failures=payload.get('requiredGateFailures',[])
        require(all(f.get('gate') in ('G0','G1','G2','G3','G4','G5','G6') and f.get('evidenceHash') for f in failures), '必要失败缺证据')
        problem = problem or ('required-gate-failure' if failures else None)
        reviews = assessed(state);complete=set(reviews)=={s['id'] for s in slots()}
        complete = complete and not state['paused'] and state['activeRecovery'] is None
        verdict = 'NO-GO' if problem else ('GO' if complete and payload.get('allGatesPassed') is True else 'INCOMPLETE')
        require(payload['verdict'] == verdict and payload.get('reportHash') and payload.get('cleanupHash'), '关闭结论或证据不符')
        state['closure'] = {**payload,'at':now,'decisiveFailure':problem};state['phase']='R6'
    else:
        raise Refused('未定义或尚未实现的操作')
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
