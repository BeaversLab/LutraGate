import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight } from "lucide-react";
import type { AdminApi, AccessKeyRow, GrantEntry, KeyRow, ProviderRow, UserRow } from "../lib/api";
import { parseLimitInput, usageTokens } from "../lib/quota";
import { dateInputToExpiry, expiryToDateInput, formatDate, formatExpiry, formatLastUsed, parseCidrList } from "../lib/access-control";
import { toErrorMessage } from "../lib/error";
import { Modal } from "./Modal";
import { useConfirm } from "./ConfirmModal";
import { OneTimeSecret } from "./OneTimeSecret";
import { AsideTabs, DetailPage } from "./SplitDetail";

/** 一次性凭证弹窗负载：lgm_/lgk_ 明文仅经 OneTimeSecret 展示一次。 */
interface IssuedSecret {
  title: string;
  secret: string;
  hint: string;
}

/**
 * 用户与授权（UI 2.0，对齐供应商/映射/Key 形态）：列表平铺表（用户名/角色/
 * 管理凭证尾号/行内启停滑块/过期）+ 编辑/新建整页（DetailPage）内三页签——
 * 基本信息（凭证信息/过期编辑/重置/删除）、上游 Key 授权（勾选 + 日预算，
 * 整组替换）、访问 Key（创建/过期与 IP 编辑/删除，lgk_ 一次性展示）。lgm_
 * 一律称「管理凭证」；已创建凭证不可再读明文，仅创建/重置时经 OneTimeSecret
 * 弹窗展示一次；删除用户仍走吊销影响面弹窗（multi-user 06 / access-control 03
 * 语义零回退）。启停是行内滑块（不进编辑页，同供应商拍板）。
 */
export function UsersPanel({ api }: { api: AdminApi }) {
  const { t } = useTranslation();
  const [users, setUsers] = useState<UserRow[]>([]);
  /** admin 视角 /admin/access-keys 返回全量（含 user_id），按编辑中用户过滤。 */
  const [accessKeys, setAccessKeys] = useState<AccessKeyRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** 编辑态："new" = 创建用户；user id = 详情；null = 列表态。 */
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [issued, setIssued] = useState<IssuedSecret | null>(null);
  const [deleting, setDeleting] = useState<UserRow | null>(null);
  // 脏草稿守卫（#23）：同 ProvidersPanel 的四路径守卫。
  const [editDirty, setEditDirty] = useState(false);
  const editDirtyRef = useRef(false);
  editDirtyRef.current = editDirty;
  const [saveEpoch, setSaveEpoch] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const [u, k] = await Promise.all([api.listUsers(), api.listAccessKeys()]);
      setUsers(u);
      setAccessKeys(k);
      setError(null);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const { confirmAction, dialog } = useConfirm();

  /** 关闭守卫（#23）：脏草稿先确认；‹/Escape/取消共用。 */
  const closeEdit = useCallback(async (): Promise<boolean> => {
    if (editDirtyRef.current && !(await confirmAction(t("common.unsavedConfirm")))) return false;
    setEditDirty(false);
    setEditing(null);
    return true;
  }, [confirmAction, t]);

  const toggle = async (user: UserRow) => {
    try {
      await api.updateUser(user.id, { enabled: !user.enabled });
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  /** 该用户是否是唯一启用的 administrator（吊销影响面弹窗的警告依据 + 角色锁定）。 */
  const isSoleAdmin = (user: UserRow): boolean =>
    user.role === "administrator"
    && user.enabled
    && users.filter((u) => u.role === "administrator" && u.enabled).length === 1;

  const remove = async (user: UserRow) => {
    try {
      await api.deleteUser(user.id);
      setDeleting(null);
      setEditing(null);
      await refresh();
    } catch (err) {
      setDeleting(null);
      setError(toErrorMessage(err));
    }
  };

  // 编辑页内容随列表刷新同步：按 id 回找最新行；列表里已消失的编辑行（删除
  // 竞态）自动落回列表态。
  const editingUser =
    editing === null || editing === "new" ? null : users.find((u) => u.id === editing) ?? null;
  const effectiveEditing = editing !== null && editing !== "new" && editingUser === null ? null : editing;

  const editPage = effectiveEditing === null ? null : (
    <DetailPage
      title={effectiveEditing === "new" ? t("users.create") : editingUser!.name}
      onClose={() => void closeEdit()}
      onDirtyChange={setEditDirty}
      dirtyResetKey={saveEpoch}
    >
      {effectiveEditing === "new" ? (
        <CreateUserForm
          api={api}
          onDone={() => {
            void refresh();
            setEditing(null); // 凭证弹窗承接收尾，回落列表态
          }}
          onCancel={() => void closeEdit()}
          onIssued={(result) =>
            setIssued({
              title: t("users.info.createIssuedTitle", { name: result.name }),
              secret: result.management_token,
              hint: t("users.info.createIssuedHint"),
            })}
        />
      ) : (
        <UserDetail
          // key 挂 user id：同 id 刷新不重挂（页签/草稿保留），切行重挂（#15 教训）。
          key={editingUser!.id}
          api={api}
          user={editingUser!}
          roleLocked={isSoleAdmin(editingUser!)}
          accessKeys={accessKeys.filter((k) => k.user_id === editingUser!.id)}
          onSaved={() => {
            setSaveEpoch((e) => e + 1);
            void refresh();
          }}
          onDelete={() => setDeleting(editingUser!)}
          onIssued={setIssued}
        />
      )}
    </DetailPage>
  );

  return (
    <section>
      {editPage !== null ? (
        editPage
      ) : (
        <>
          <div className="panel-head">
            <h2>{t("users.title")}</h2>
            <button onClick={() => setEditing("new")}>{t("users.create")}</button>
          </div>
          {/* 说明行占位（nbsp 保行高）：标题区高度与其他面板节奏一致。 */}
          <p className="hint">&nbsp;</p>
          {error && <p className="error" role="alert">{error}</p>}

          <div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("users.colName")}</th>
                    <th>{t("users.colRole")}</th>
                    <th>{t("users.colCredential")}</th>
                    <th>{t("users.colStatus")}</th>
                    <th>{t("users.colExpiry")}</th>
                    <th aria-hidden="true"></th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr
                      key={u.id}
                      tabIndex={0}
                      onClick={() => setEditing(u.id)}
                      // 键盘可达（tabIndex 配套，#18 先例）：Enter/Space = 进编辑页。
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setEditing(u.id);
                        }
                      }}
                    >
                      <td>{u.name}</td>
                      <td>
                        <span className={u.role === "administrator" ? "badge on" : "badge off"}>{u.role}</span>
                      </td>
                      <td className="mono">{u.token_hint ? `lgm_****${u.token_hint}` : "—"}</td>
                      <td>
                        {/* 行内启用滑块 + 状态文字（同供应商形态）；点击不冒泡触发行编辑。 */}
                        <span className="prov-switch">
                          <span className="prov-switch-label">
                            {u.enabled ? t("users.statusOn") : t("users.statusOff")}
                          </span>
                          <input
                            type="checkbox"
                            className="switch"
                            checked={u.enabled}
                            onChange={() => void toggle(u)}
                            aria-label={u.enabled ? t("users.disable") : t("users.enable")}
                            onClick={(e) => e.stopPropagation()}
                          />
                        </span>
                      </td>
                      <td>{formatExpiry(u.token_expires_at)}</td>
                      {/* 行尾显式编辑入口（同供应商/映射「编辑 ›」）。 */}
                      <td className="row-edit-cell">
                        <button type="button" className="row-edit">
                          {t("users.edit")}
                          <ChevronRight size={14} aria-hidden="true" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr><td colSpan={6} className="empty">{t("users.emptyList")}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {issued !== null && (
        <OneTimeSecret title={issued.title} secret={issued.secret} hint={issued.hint} onAck={() => setIssued(null)} />
      )}

      {deleting !== null && (
        <DeleteUserModal
          api={api}
          user={deleting}
          soleAdmin={isSoleAdmin(deleting)}
          onConfirm={() => void remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}

      {dialog}
    </section>
  );
}

/** 编辑中用户的详情页内容（#17 起，随面板整页化）：基本信息 / 上游 Key 授权 / 访问 Key 三页签。 */
function UserDetail({
  api,
  user,
  accessKeys,
  roleLocked,
  onSaved,
  onDelete,
  onIssued,
}: {
  api: AdminApi;
  user: UserRow;
  accessKeys: AccessKeyRow[];
  /** 唯一启用的 administrator：角色锁定不可降权（server lastAdminGuard 409 兜底）。 */
  roleLocked: boolean;
  onSaved: () => void;
  onDelete: () => void;
  onIssued: (secret: IssuedSecret) => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"info" | "grants" | "keys">("info");

  return (
    <>
      <AsideTabs
        tabs={[
          { key: "info", label: t("users.tabs.info") },
          { key: "grants", label: t("users.tabs.grants") },
          { key: "keys", label: t("users.tabs.keys") },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "info" && (
        <UserInfoForm
          api={api}
          user={user}
          roleLocked={roleLocked}
          onSaved={onSaved}
          onDelete={onDelete}
          onIssued={onIssued}
        />
      )}

      {tab === "grants" && <GrantsEditor api={api} user={user} onSaved={onSaved} />}
      {tab === "keys" && (
        <UserAccessKeys api={api} user={user} accessKeys={accessKeys} onSaved={onSaved} onIssued={onIssued} />
      )}
    </>
  );
}

/**
 * 基本信息编辑表单：可编辑字段在前（用户名 / 角色 / 过期时间，显示处即编辑
 * 处），只读事实在后（管理凭证尾号 / 最近使用）——全部共用同一 field-row
 * 96px 标签列对齐。过期走独立 token 端点（PUT 只改过期、不轮换，
 * access-control 03）；名称/角色走用户 PATCH，仅在变化时发送。roleLocked
 * （唯一启用 administrator）时角色 select 置灰锁定。动作行合一：删除靠左
 * （form-actions-lead）、重置/保存靠右。
 */
function UserInfoForm({
  api,
  user,
  roleLocked,
  onSaved,
  onDelete,
  onIssued,
}: {
  api: AdminApi;
  user: UserRow;
  roleLocked: boolean;
  onSaved: () => void;
  onDelete: () => void;
  onIssued: (secret: IssuedSecret) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<"administrator" | "user">(user.role);
  const [expiresOn, setExpiresOn] = useState(expiryToDateInput(user.token_expires_at));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  const reset = async () => {
    setResetting(true);
    try {
      const result = await api.resetUserToken(user.id);
      onIssued({
        title: t("users.info.resetIssuedTitle"),
        secret: result.management_token,
        hint: t("users.info.resetIssuedHint"),
      });
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setResetting(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const expiresAt = dateInputToExpiry(expiresOn);
    if (expiresAt < 0) {
      setError(t("users.info.invalidDate"));
      return;
    }
    setSaving(true);
    try {
      if (name !== user.name || role !== user.role) {
        await api.updateUser(user.id, {
          ...(name !== user.name ? { name } : {}),
          ...(role !== user.role ? { role } : {}),
        });
      }
      if (expiresOn !== expiryToDateInput(user.token_expires_at)) {
        await api.updateUserTokenExpiry(user.id, expiresAt);
      }
      onSaved();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="detail-fields" onSubmit={submit}>
      <label className="field-row">
        {t("users.nameLabel")}
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="field-row">
        {t("users.roleLabel")}
        <select value={role} disabled={roleLocked} onChange={(e) => setRole(e.target.value as "administrator" | "user")}>
          <option value="user">{t("users.roleUser")}</option>
          <option value="administrator">{t("users.roleAdmin")}</option>
        </select>
      </label>
      {roleLocked && <p className="hint-inline">{t("users.info.roleLockedHint")}</p>}
      <label className="field-row">
        {t("users.info.expiryField")}
        <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
      </label>
      <p className="hint-inline">{t("users.info.expiryEmptyHint")}</p>
      {/* 只读事实行：与上方字段共用 field-row 标签列（对齐同一控件列）。 */}
      <div className="field-row">
        <span>{t("users.info.credential")}</span>
        <span className="mono">{user.token_hint ? `lgm_****${user.token_hint}` : "—"}</span>
      </div>
      <div className="field-row">
        <span>{t("users.info.lastUsed")}</span>
        <span>{formatLastUsed(user.token_last_used_at)}</span>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {/* 动作行合一：删除靠左，重置/保存靠右（同供应商编辑页拍板）。 */}
      <div className="form-actions">
        <button type="button" className="danger form-actions-lead" onClick={onDelete}>
          {t("users.delete")}
        </button>
        <button type="button" onClick={() => void reset()} disabled={resetting}>
          {resetting ? t("users.info.resetting") : t("users.info.reset")}
        </button>
        <button type="submit" className="primary" disabled={saving}>{t("users.save")}</button>
      </div>
    </form>
  );
}

/**
 * 访问 Key 管理（#17，admin 代管；嵌套子列表 → 表格 + 模态框——编辑页内无法
 * 再嵌 DetailPage，模态是自然层级，且表格列对齐由构造保证）：列出该用户的
 * lgk_，可代建（明文仅一次）、行内启停、编辑过期与 IP 白名单、删除。名称与
 * 日限额的自助编辑在「我的 Key」（用户侧）。模态内容 data-dirty-ignore 豁免
 * 外层编辑页的脏检测（key 编辑有自己的未保存守卫，二者独立）。
 */
function UserAccessKeys({
  api,
  user,
  accessKeys,
  onSaved,
  onIssued,
}: {
  api: AdminApi;
  user: UserRow;
  accessKeys: AccessKeyRow[];
  onSaved: () => void;
  onIssued: (secret: IssuedSecret) => void;
}) {
  const { t } = useTranslation();
  const { confirmAction, dialog } = useConfirm();
  /** 编辑态："new" = 创建模态；key id = 编辑模态；null = 仅表格。 */
  const [editing, setEditing] = useState<AccessKeyRow | "new" | null>(null);
  const [modalDirty, setModalDirty] = useState(false);
  const modalDirtyRef = useRef(false);
  modalDirtyRef.current = modalDirty;
  // 模态内错误就地呈现（模态关闭即清）。
  const [modalError, setModalError] = useState<string | null>(null);

  /** 模态关闭守卫：脏草稿先确认（✕/遮罩/Escape/取消共用）；saved=true 跳过
   *  守卫（保存成功路径——dirty 复位是异步 state，ref 还没跟上）。 */
  const closeModal = useCallback(async (saved = false): Promise<boolean> => {
    if (!saved && modalDirtyRef.current && !(await confirmAction(t("common.unsavedConfirm")))) return false;
    setModalDirty(false);
    setEditing(null);
    setModalError(null);
    return true;
  }, [confirmAction, t]);

  const create = async (name: string): Promise<boolean> => {
    try {
      const created = await api.createUserAccessKey(user.id, { name });
      setEditing(null);
      setModalDirty(false);
      onIssued({
        title: t("users.keys.issuedTitle", { name: created.name }),
        secret: created.access_key,
        hint: t("users.keys.issuedHint"),
      });
      onSaved();
      return true;
    } catch (err) {
      setModalError(toErrorMessage(err));
      return false;
    }
  };

  const remove = async (key: AccessKeyRow) => {
    const confirmed = await confirmAction(
      t("users.keys.revokeConfirm", { name: key.name, hint: `****${key.key_hint}` }),
    );
    if (!confirmed) return;
    try {
      await api.deleteAccessKey(key.id);
      setEditing(null);
      setModalDirty(false);
      onSaved();
    } catch (err) {
      setModalError(toErrorMessage(err));
    }
  };

  return (
    <>
      <div className="keys-toolbar">
        <button onClick={() => { setModalError(null); setEditing("new"); }}>{t("users.keys.createTitle")}</button>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>{t("users.keys.nameLabel")}</th>
              <th>{t("users.colCredential")}</th>
              <th>{t("users.colStatus")}</th>
              <th>{t("users.colExpiry")}</th>
              <th>{t("users.keys.ipField")}</th>
              <th aria-hidden="true"></th>
            </tr>
          </thead>
          <tbody>
            {accessKeys.map((k) => (
              <tr
                key={k.id}
                tabIndex={0}
                onClick={() => { setModalError(null); setEditing(k); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setEditing(k);
                  }
                }}
              >
                <td>{k.name}</td>
                <td className="mono">****{k.key_hint}</td>
                <td>
                  <InlineKeySwitch api={api} row={k} onSaved={onSaved} />
                </td>
                <td>{formatExpiry(k.expires_at)}</td>
                {/* IP 列：首条 + 余数计数（白名单多时只示意首条；空 = 不限）。 */}
                <td className="mono">
                  {k.ip_allowlist.length === 0
                    ? t("quota.unlimited")
                    : k.ip_allowlist.length > 1
                      ? `${k.ip_allowlist[0]} +${k.ip_allowlist.length - 1}`
                      : k.ip_allowlist[0]}
                </td>
                <td className="row-edit-cell">
                  <button type="button" className="row-edit">{t("users.edit")}</button>
                </td>
              </tr>
            ))}
            {accessKeys.length === 0 && (
              <tr><td colSpan={6} className="empty">{t("users.keys.empty")}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing !== null && (
        // data-dirty-ignore：模态内输入不算外层用户编辑页的草稿（两套守卫独立）。
        <div data-dirty-ignore>
          <Modal
            title={editing === "new" ? t("users.keys.createTitle") : t("users.keys.editTitle", { name: editing.name })}
            closeOnEscape
            onClose={() => void closeModal(false)}
          >
            {editing === "new" ? (
              <AccessKeyCreateForm onCreate={create} error={modalError} />
            ) : (
              <AccessKeyEditForm
                key={editing.id}
                api={api}
                row={editing}
                error={modalError}
                onDirty={setModalDirty}
                onSaved={onSaved}
                onClose={(saved) => void closeModal(saved)}
                onDelete={() => void remove(editing)}
              />
            )}
          </Modal>
        </div>
      )}
      {dialog}
    </>
  );
}

/** 表格行内启停（立即 PUT）：点击不冒泡触发行编辑。 */
function InlineKeySwitch({ api, row, onSaved }: { api: AdminApi; row: AccessKeyRow; onSaved: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const toggle = async () => {
    try {
      await api.updateAccessKey(row.id, { enabled: !row.enabled });
      onSaved();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };
  return (
    <>
      <span className="prov-switch" data-dirty-ignore onClick={(e) => e.stopPropagation()}>
        <span className="prov-switch-label">
          {row.enabled ? t("users.statusOn") : t("users.statusOff")}
        </span>
        <input
          type="checkbox"
          className="switch"
          checked={row.enabled}
          onChange={() => void toggle()}
          aria-label={row.enabled ? t("users.disable") : t("users.enable")}
        />
      </span>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

/** 创建模态表单：只有名称（限额自助归「我的 Key」）；成功经 OneTimeSecret 展示明文。 */
function AccessKeyCreateForm({
  onCreate,
  error,
}: {
  onCreate: (name: string) => Promise<boolean>;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await onCreate(name);
    } finally {
      setCreating(false);
    }
  };

  return (
    <form className="detail-fields" onSubmit={submit}>
      <label className="field-row">
        {t("users.keys.nameLabel")}
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("users.keys.namePlaceholder")} required />
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={creating}>{t("users.keys.createSubmit")}</button>
      </div>
    </form>
  );
}

/** 编辑模态表单：过期 + IP 白名单（admin 代管范围）；删除靠左，脏草稿守卫在面板。 */
function AccessKeyEditForm({
  api,
  row,
  error,
  onDirty,
  onSaved,
  onClose,
  onDelete,
}: {
  api: AdminApi;
  row: AccessKeyRow;
  error: string | null;
  onDirty: (dirty: boolean) => void;
  onSaved: () => void;
  /** saved=true：保存成功后关闭，跳过未保存守卫。 */
  onClose: (saved?: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [expiresOn, setExpiresOn] = useState(expiryToDateInput(row.expires_at));
  const [ipList, setIpList] = useState(row.ip_allowlist.join("\n"));
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const expiresAt = dateInputToExpiry(expiresOn);
    if (expiresAt < 0) {
      setLocalError(t("users.keys.invalidDate"));
      return;
    }
    const parsed = parseCidrList(ipList);
    if (parsed.error !== null) {
      setLocalError(parsed.error);
      return;
    }
    setSaving(true);
    try {
      await api.updateAccessKey(row.id, { expires_at: expiresAt, ip_allowlist: parsed.list });
      onSaved();
      onClose(true);
    } catch (err) {
      setLocalError(toErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="detail-fields" onSubmit={submit}>
      <label className="field-row">
        {t("users.keys.expiryField")}
        <input type="date" value={expiresOn} onChange={(e) => { setExpiresOn(e.target.value); onDirty(true); }} />
      </label>
      <p className="hint-inline">{t("users.info.expiryEmptyHint")}</p>
      <label className="field-row">
        {t("users.keys.ipField")}
        <textarea rows={3} className="mono" value={ipList} onChange={(e) => { setIpList(e.target.value); onDirty(true); }} />
      </label>
      <p className="hint-inline">{t("users.keys.ipFieldHint")}</p>
      {(localError ?? error) && <p className="error" role="alert">{localError ?? error}</p>}
      {/* 动作行：删除靠左（form-actions-lead），取消/保存靠右（同编辑页拍板）。 */}
      <div className="form-actions">
        <button type="button" className="danger form-actions-lead" onClick={onDelete}>{t("users.keys.delete")}</button>
        <button type="button" onClick={() => onClose()}>{t("users.cancel")}</button>
        <button type="submit" className="primary" disabled={saving}>{t("users.keys.save")}</button>
      </div>
    </form>
  );
}

/** 按 provider 分组的授权勾选编辑器（#17 迁入 aside 页签）：每行可填授权级日
 * 预算（quota，0/空 = 不限）；保存即整组替换（PUT 条目对象集合）。
 * onSaved（#23）：保存成功后上报面板，复位脏态（勾选也计草稿）。 */
function GrantsEditor({ api, user, onSaved }: { api: AdminApi; user: UserRow; onSaved: () => void }) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [checked, setChecked] = useState<Set<string> | null>(null);
  /** 授权级预算输入：provider_key_id → {token, request}（字符串；空 = 不限）。 */
  const [budgets, setBudgets] = useState<Map<string, { token: string; request: string }>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [p, k, grants] = await Promise.all([api.listProviders(), api.listKeys(), api.getUserGrants(user.id)]);
        setProviders(p);
        setKeys(k);
        setChecked(new Set(grants.grants.map((g) => g.provider_key_id)));
        // 现有预算回填输入框（0 → 空 = 不限）。
        setBudgets(new Map(grants.grants.map((g) => [g.provider_key_id, {
          token: g.daily_token_limit > 0 ? String(g.daily_token_limit) : "",
          request: g.daily_request_limit > 0 ? String(g.daily_request_limit) : "",
        }])));
      } catch (err) {
        setError(toErrorMessage(err));
      }
    })();
  }, [api, user.id]);

  const toggleKey = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev ?? new Set<string>());
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setBudget = (id: string, field: "token" | "request", value: string) => {
    setBudgets((prev) => {
      const next = new Map(prev);
      const current = next.get(id) ?? { token: "", request: "" };
      next.set(id, { ...current, [field]: value });
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const entries: GrantEntry[] = [...(checked ?? new Set<string>())].map((id) => {
        const budget = budgets.get(id);
        return {
          provider_key_id: id,
          daily_token_limit: parseLimitInput(budget?.token ?? ""),
          daily_request_limit: parseLimitInput(budget?.request ?? ""),
        };
      });
      await api.replaceUserGrants(user.id, entries);
      onSaved();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="detail-fields">
      {/* 功能性微提示（唯一保留的说明文字）：本页签职责 = 传达允许使用哪些 Key。 */}
      <p className="hint">{t("users.grants.hint")}</p>
      {providers.map((p) => {
        const providerKeys = keys.filter((k) => k.provider_id === p.id);
        // 组级摘要：允许计数随勾选实时（permission list 核心是「允许集合」一眼可扫）。
        const allowedCount = providerKeys.filter((k) => checked?.has(k.id)).length;
        return (
          <div className="grant-group" key={p.id}>
            <div className="grant-provider">
              <span>{p.name}</span>
              {providerKeys.length > 0 && (
                <span className="grant-count">
                  {t("users.grants.count", { allowed: allowedCount, total: providerKeys.length })}
                </span>
              )}
            </div>
            {providerKeys.map((k) => {
              const budget = budgets.get(k.id) ?? { token: "", request: "" };
              const allowed = checked?.has(k.id) ?? false;
              return (
                // 勾选行即状态卡：选中行 primary 微底色强化「允许集合」；状态用
                // 文字徽标表达（不靠颜色单通道）。延迟保存场景 checkbox 语义正确。
                <div key={k.id} className={`grant-choice ${allowed ? "allowed" : ""}`}>
                  <label>
                    <input
                      type="checkbox"
                      checked={allowed}
                      onChange={() => toggleKey(k.id)}
                      aria-label={t("users.grants.keyAria", { hint: k.key_hint })}
                    />
                    <span className="mono grant-key">****{k.key_hint}</span>
                    <span className={allowed ? "badge on" : "badge off"}>
                      {allowed ? t("users.grants.allowed") : t("users.grants.notAllowed")}
                    </span>
                    {k.enabled === 0 && <span className="badge off">{t("users.statusOff")}</span>}
                  </label>
                  {allowed && (
                    <span className="grant-budget">
                      <label>
                        {t("users.grants.budgetToken")}
                        <input type="number" min={0} step={1} value={budget.token}
                          onChange={(e) => setBudget(k.id, "token", e.target.value)}
                          placeholder={t("quota.unlimited")}
                          aria-label={t("users.grants.budgetTokenAria", { hint: k.key_hint })} />
                      </label>
                      <label>
                        {t("users.grants.budgetRequest")}
                        <input type="number" min={0} step={1} value={budget.request}
                          onChange={(e) => setBudget(k.id, "request", e.target.value)}
                          placeholder={t("quota.unlimited")}
                          aria-label={t("users.grants.budgetRequestAria", { hint: k.key_hint })} />
                      </label>
                    </span>
                  )}
                </div>
              );
            })}
            {providerKeys.length === 0 && <p className="hint">{t("users.grants.emptyProvider")}</p>}
          </div>
        );
      })}
      {providers.length === 0 && <p className="hint">{t("users.grants.noProviders")}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" className="primary" onClick={save} disabled={saving || checked === null}>
          {t("users.grants.save")}
        </button>
      </div>
    </div>
  );
}

function CreateUserForm({
  api,
  onDone,
  onCancel,
  onIssued,
}: {
  api: AdminApi;
  onDone: () => void;
  onCancel: () => void;
  onIssued: (result: { name: string; management_token: string }) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [role, setRole] = useState<"administrator" | "user">("user");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await api.createUser({ name, role });
      onIssued(created);
      onDone();
    } catch (err) {
      setError(toErrorMessage(err));
    }
  };

  return (
    <form className="detail-fields" onSubmit={submit}>
      <label className="field-row">
        {t("users.nameLabel")}
        <input value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="field-row">
        {t("users.roleLabel")}
        <select value={role} onChange={(e) => setRole(e.target.value as "administrator" | "user")}>
          <option value="user">{t("users.roleUser")}</option>
          <option value="administrator">{t("users.roleAdmin")}</option>
        </select>
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button type="button" onClick={onCancel}>{t("users.cancel")}</button>
        <button type="submit" className="primary">{t("users.createSubmit")}</button>
      </div>
    </form>
  );
}

/** 删除用户（= 吊销其 lgm_ 管理凭证）确认弹窗：归属 + 凭证生命周期 + 今日用量 + 唯一管理员警告。 */
function DeleteUserModal({
  api,
  user,
  soleAdmin,
  onConfirm,
  onCancel,
}: {
  api: AdminApi;
  user: UserRow;
  soleAdmin: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<{ requests: number; tokens: number } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.getUsage({ today: true, user_id: user.id });
        const row = result.usage[0];
        setUsage(row ? { requests: row.requests, tokens: usageTokens(row) } : { requests: 0, tokens: 0 });
      } catch {
        setUsage({ requests: 0, tokens: 0 }); // 用量查询失败不阻塞删除决策
      }
    })();
  }, [api, user.id]);

  return (
    <Modal title={t("users.deleteTitle", { name: user.name })} onClose={onCancel}>
      <dl className="revoke-facts">
        <div><dt>{t("users.deleteFacts.nameRole")}</dt><dd>{user.name}（{user.role}）</dd></div>
        <div><dt>{t("users.deleteFacts.createdAt")}</dt><dd>{formatDate(user.created_at)}</dd></div>
        <div>
          <dt>{t("users.deleteFacts.credential")}</dt>
          <dd>{formatExpiry(user.token_expires_at)}，{formatLastUsed(user.token_last_used_at)}</dd>
        </div>
        <div>
          <dt>{t("users.deleteFacts.todayUsage")}</dt>
          <dd>
            {usage === null
              ? t("users.deleteFacts.querying")
              : t("users.deleteFacts.usageLine", { requests: usage.requests.toLocaleString(), tokens: usage.tokens.toLocaleString() })}
          </dd>
        </div>
      </dl>
      {soleAdmin && <p className="error" role="alert">{t("users.soleAdminWarn")}</p>}
      <p className="error" role="alert">{t("users.destroyWarn")}</p>
      <div className="form-actions">
        <button type="button" onClick={onCancel}>{t("users.cancel")}</button>
        <button type="button" className="danger" onClick={onConfirm} disabled={usage === null}>
          {t("users.confirmDelete")}
        </button>
      </div>
    </Modal>
  );
}
