"""首次评分只接收当前正常槽或已登记恢复尝试，恢复健康不得越过一小时窗口。"""

def first_grade_deadline(state,claim,now):
    def require(ok,message):
        if not ok:raise RuntimeError(message)
    require(not state['closure'] and 'seal'in claim and 'review'not in claim,'当前槽不允许首次评分')
    probe=claim['slot']['kind']in ('health','recovery-health')
    end=min(state['formalDeadline']-3*3600,min(claim['seal']['endedAt'],claim['executionDeadline'])+(300 if probe else 900))
    index=claim.get('recovery')
    if index is None:
        require(not state['paused'] and state['activeRecovery']is None,'暂停或恢复期间不能评分普通槽')
    else:
        require(type(index)is int and index==state['activeRecovery']and 0<=index<len(state['recoveries']),'评分尝试不属于当前恢复')
        recovery=state['recoveries'][index]
        require(state['paused'] and state['paused']['reason']=='environment'and not recovery.get('failed')and not recovery.get('completedAt'),'当前恢复不能继续评分')
        require(recovery['cooldownUntil']<=claim['claimedAt']<=recovery['deadline'],'恢复尝试未在准入窗内登记')
        if probe:end=min(end,recovery['deadline'])
    require(now<end,'评分或恢复健康窗口已经结束')
    return end
