const scopeKey = (institutionId, modelVersion) => `${institutionId}|${modelVersion}`;

/**
 * 由领域事件折叠出的放行注册表（读模型）。
 * 授权撤回等操作型状态由 WithdrawalService 在此基础上维护，
 * 全量重建 = 回放事件日志 + 回放操作型记录。
 */
export class Projections {
  datasets = new Map(); // dataset_version_id -> 事件载荷 + status
  authorizations = new Map(); // authorization_id -> 授权 + status(active/withdrawn)
  models = new Map(); // model_version -> 事件载荷
  studies = new Map(); // study_id -> 事件载荷
  releases = new Map(); // release_id -> 放行记录（含 status、suspensions）
  #scopeIndex = new Map(); // "机构|版本" -> release_id
  #activationSeq = 0;

  apply = (event) => {
    switch (event.event_type) {
      case "DATASET_APPROVED": {
        this.datasets.set(event.aggregate_id, { ...event, status: "approved" });
        this.authorizations.set(event.authorization.authorization_id, {
          ...event.authorization,
          dataset_version_id: event.aggregate_id,
          status: "active",
          withdrawal: null,
        });
        break;
      }
      case "MODEL_TRAINED": {
        this.models.set(event.aggregate_id, { ...event });
        break;
      }
      case "VALIDATION_COMPLETED": {
        this.studies.set(event.aggregate_id, { ...event });
        break;
      }
      case "RELEASE_ACTIVATED": {
        const existing = this.releases.get(event.aggregate_id);
        const record = {
          release_id: event.aggregate_id,
          institution_id: event.institution_id,
          model_version: event.model_version,
          activation_kind: event.activation_kind,
          decisions: event.decisions ?? existing?.decisions ?? null,
          boundary: event.boundary ?? existing?.boundary ?? null,
          responsibility: event.responsibility ?? existing?.responsibility ?? null,
          monitoring: event.monitoring ?? existing?.monitoring ?? null,
          status: "active",
          activated_at: event.occurred_at,
          activation_seq: ++this.#activationSeq,
          suspensions: existing?.suspensions ?? [],
        };
        this.releases.set(event.aggregate_id, record);
        this.#scopeIndex.set(scopeKey(record.institution_id, record.model_version), record.release_id);
        break;
      }
      case "MODEL_SUSPENDED": {
        const release = this.releases.get(event.aggregate_id);
        if (release) {
          release.status = "suspended";
          release.suspensions.push({
            reason: event.reason,
            detail: event.detail,
            scope: event.scope,
            effective_at: event.effective_at,
            event_id: event.event_id,
            recorded_at: event.occurred_at,
          });
        }
        break;
      }
      default:
        break;
    }
  };

  byScope(institutionId, modelVersion) {
    const releaseId = this.#scopeIndex.get(scopeKey(institutionId, modelVersion));
    return releaseId ? this.releases.get(releaseId) : null;
  }

  latestActiveForInstitution(institutionId) {
    const active = [...this.releases.values()].filter(
      (release) => release.institution_id === institutionId && release.status === "active",
    );
    active.sort((a, b) => b.activation_seq - a.activation_seq);
    return active[0] ?? null;
  }

  /** 机构最近一次的放行（不限状态）：用于暂停后仍能告知原因。 */
  latestForInstitution(institutionId) {
    const all = [...this.releases.values()].filter((release) => release.institution_id === institutionId);
    all.sort((a, b) => b.activation_seq - a.activation_seq);
    return all[0] ?? null;
  }

  /** 模型版本的血缘：训练所用的数据集版本及其授权。 */
  modelLineage(modelVersion) {
    const model = this.models.get(modelVersion);
    if (!model) return null;
    const datasets = (model.dataset_version_ids ?? [])
      .map((id) => this.datasets.get(id))
      .filter(Boolean);
    const authorizations = datasets
      .map((dataset) => this.authorizations.get(dataset.authorization.authorization_id))
      .filter(Boolean);
    return { model, datasets, authorizations };
  }
}
