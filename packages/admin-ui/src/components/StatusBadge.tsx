import { useTranslation } from "react-i18next";
import type { CredentialStatus } from "../lib/access-control";

/** 凭证状态徽标（lgk_ / lgm_ 统一四态；非启用统一 off 配色）。文案经 i18n
 * （status.*，UI 2.0 #19——枚举本身不再携带展示语言）。 */
export function StatusBadge({ status }: { status: CredentialStatus }) {
  const { t } = useTranslation();
  return status === "active"
    ? <span className="badge on">{t("status.active")}</span>
    : <span className="badge off">{t(`status.${status}`)}</span>;
}
