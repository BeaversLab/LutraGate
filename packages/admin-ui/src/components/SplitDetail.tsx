import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";

/**
 * split 列表+详情共用原语（UI 2.0 #14，供 06–10 各列表页复用）：
 * 左列表 + 右详情 aside。选中态、筛选、翻页、滚动全部归左侧列表（面板自管，
 * 结构上 aside 是兄弟节点——打开详情绝不重挂列表，筛选/滚动自然保留，
 * spec 故事 21）。aside 无内容时整列收起，列表占满。
 */
export function SplitLayout({ list, aside }: { list: ReactNode; aside: ReactNode }) {
  return (
    <div className={`split-layout ${aside === null ? "" : "with-aside"}`}>
      <div className="split-list">{list}</div>
      {aside !== null && <div className="split-aside">{aside}</div>}
    </div>
  );
}

/**
 * 脏草稿检测（#23）共用 hook：捕获 root 内用户编辑控件（input/textarea/select）
 * 的输入与按钮点击即标脏；`data-dirty-ignore` 子树豁免（连通性测试 Key、导入
 * 候选等临时交互不算草稿）。面板经 `onDirtyChange` 收脏态用于关闭/切换守卫，
 * 经 `dirtyResetKey`（保存回执，如面板 saveEpoch 或行 updated_at）复位。
 */
function useDirtyDraft(
  rootRef: RefObject<HTMLElement | null>,
  { dirtyResetKey, onDirtyChange }: { dirtyResetKey?: unknown; onDirtyChange?: (dirty: boolean) => void },
): boolean {
  const [dirty, setDirty] = useState(false);
  const onDirtyChangeRef = useRef(onDirtyChange);
  onDirtyChangeRef.current = onDirtyChange;
  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);
  useEffect(() => {
    setDirty(false);
  }, [dirtyResetKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const markDirty = (e: Event) => {
      const target = e.target as HTMLElement;
      if (target.closest?.("[data-dirty-ignore]") !== null) return;
      if (e.type === "input" || e.type === "change") {
        if (target.matches?.("input, textarea, select")) setDirty(true);
        return;
      }
      // click：行内编辑动作（增删端点行等）也算草稿变更；提交/操作排（保存、
      // 启停、吊销等）不算。
      const button = target.closest?.("button");
      if (
        button !== null &&
        button?.type !== "submit" &&
        button?.closest(".form-actions") === null &&
        button?.closest(".aside-topbar") === null
      ) {
        setDirty(true);
      }
    };
    root.addEventListener("input", markDirty, true);
    root.addEventListener("change", markDirty, true);
    root.addEventListener("click", markDirty, true);
    return () => {
      root.removeEventListener("input", markDirty, true);
      root.removeEventListener("change", markDirty, true);
      root.removeEventListener("click", markDirty, true);
    };
  }, []);
  return dirty;
}

/**
 * 详情 aside（spec 故事 22）：显式关闭按钮 + Escape 关闭 + 键盘焦点管理——
 * 打开时焦点移入 aside（关闭按钮），关闭时还原到打开前的焦点（通常是
 * 选中的列表行）。onClose 经 ref 透传，effect 只在挂载时跑一次，重渲染
 * 不会反复抢焦点。
 *
 * 脏草稿检测（#23）：useDirtyDraft 共用 hook（DetailPage 同源）。
 * 关闭动作本身仍由面板的 onClose 守卫（✕/Escape 都汇到那里）。
 */
export function DetailAside({
  title,
  onClose,
  dirtyResetKey,
  onDirtyChange,
  children,
}: {
  title: string;
  onClose: () => void;
  /** 变化即复位脏态（保存成功后由面板递增的回执键）。 */
  dirtyResetKey?: unknown;
  onDirtyChange?: (dirty: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<Element | null>(null);
  // onClose 可能每次渲染都是新箭头函数——存 ref，监听器只挂一次。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useDirtyDraft(rootRef, { dirtyResetKey, onDirtyChange });

  useEffect(() => {
    // 焦点锚点只记 aside 外的元素：StrictMode 开发态双跑 effect 时，第二次
    // 跑 activeElement 已是 aside 内的关闭按钮，重捕会令还原目标失效。
    const root = rootRef.current;
    if (root === null || !root.contains(document.activeElement)) {
      restoreFocusRef.current = document.activeElement;
    }
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (restoreFocusRef.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  return (
    <aside ref={rootRef} className="detail-aside panel-card" aria-label={title}>
      <div className="detail-aside-head">
        <h3>{title}</h3>
        <button ref={closeBtnRef} type="button" aria-label={t("common.close")} onClick={onClose}>
          ✕
        </button>
      </div>
      {children}
    </aside>
  );
}

/**
 * 详情页签（chip 形态 tablist）共用原语：#17（用户）/ #18（日志）各一份
 * aside-tabs 拷贝，用户面板换轨整页（第三份出现）时抽出。页签状态由调用方
 * 自管——通常挂在详情组件内部，随 key={id} 重挂复位（#15 教训）。
 */
export function AsideTabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: ReadonlyArray<{ key: T; label: string }>;
  active: T;
  onChange: (key: T) => void;
}) {
  return (
    <div className="aside-tabs" role="tablist">
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          role="tab"
          type="button"
          aria-selected={active === key}
          className={active === key ? "active" : ""}
          onClick={() => onChange(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * 详情整页原语（供应商编辑页起）：与 DetailAside 同一套 Escape 关闭、焦点
 * 管理（入页焦点到返回按钮、退出还原）与脏草稿检测（useDirtyDraft），但
 * 渲染为占满主区的整页——reference 编辑页形态；aside 320px 对供应商表单
 * （左标签+端点行+测试段）太挤。关闭动作由面板 onClose 守卫（返回/Escape）。
 */
export function DetailPage({
  title,
  hint,
  onClose,
  dirtyResetKey,
  onDirtyChange,
  children,
}: {
  title: string;
  /** 标题下的灰色描述行（reference 编辑页文案位）。 */
  hint?: string;
  onClose: () => void;
  dirtyResetKey?: unknown;
  onDirtyChange?: (dirty: boolean) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const backRef = useRef<HTMLButtonElement | null>(null);
  const rootRef = useRef<HTMLElement | null>(null);
  const restoreFocusRef = useRef<Element | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useDirtyDraft(rootRef, { dirtyResetKey, onDirtyChange });

  useEffect(() => {
    const root = rootRef.current;
    if (root === null || !root.contains(document.activeElement)) {
      restoreFocusRef.current = document.activeElement;
    }
    backRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      (restoreFocusRef.current as HTMLElement | null)?.focus?.();
    };
  }, []);

  return (
    <section ref={rootRef} className="detail-page" aria-label={title}>
      {/* 标题行 + 提示行结构与列表态 panel-head+hint 同构（样式一致性走查）。 */}
      <div className="detail-page-head">
        <button ref={backRef} type="button" className="back-btn" aria-label={t("common.back")} onClick={onClose}>
          ‹
        </button>
        <h2>{title}</h2>
      </div>
      {hint && <p className="hint detail-page-hint">{hint}</p>}
      {children}
    </section>
  );
}
