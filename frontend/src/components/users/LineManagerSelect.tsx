import { useQuery } from "@tanstack/react-query";
import { groupsAPI } from "@/services/api";
import CustomListbox from "@/components/ui/CustomListbox";

interface Group { id: string; name: string }
interface Manager { id: string; full_name: string; email: string }
interface Membership { user?: Manager; is_active?: boolean; expires_at?: string | null }

export default function LineManagerSelect({
  groups,
  value,
  onChange,
}: {
  groups: Group[];
  value: string;
  onChange: (id: string) => void;
}) {
  const managerGroup = groups.find((group) => group.name.trim().toLowerCase() === "managers");
  const { data: managers = [], isLoading } = useQuery<Manager[]>({
    queryKey: ["group-members", managerGroup?.id, "line-manager"],
    queryFn: async () => {
      if (!managerGroup) return [];
      const response = await groupsAPI.members(managerGroup.id, { active_only: true });
      const raw: Membership[] = response.data?.results ?? response.data ?? [];
      const now = Date.now();
      return raw
        .filter((membership) => membership.is_active !== false && (!membership.expires_at || new Date(membership.expires_at).getTime() > now))
        .map((membership) => membership.user)
        .filter((user): user is Manager => Boolean(user?.id))
        .sort((a, b) => a.full_name.localeCompare(b.full_name));
    },
    enabled: Boolean(managerGroup),
    staleTime: 60_000,
  });

  const selectedIsKnown = managers.some((manager) => manager.id === value);
  return (
    <div>
      <CustomListbox
        value={selectedIsKnown ? value : ""}
        onChange={(next) => onChange(next || "")}
        options={[
          { value: "", label: isLoading ? "Loading Managers…" : managerGroup ? "— None —" : "Create a Managers group first" },
          ...managers.map((manager) => ({
            value: manager.id,
            label: `${manager.full_name || manager.email} (${manager.email})`,
          })),
        ]}
        buttonClassName="input"
        ariaLabel="Line Manager"
        disabled={!managerGroup || isLoading}
      />
      {!managerGroup && <p className="mt-1 text-xs text-muted-foreground">Line Managers are selected from the active Managers group.</p>}
      {value && !selectedIsKnown && <p className="mt-1 text-xs text-amber-700">The saved manager is not an active Managers group member. Select a replacement.</p>}
    </div>
  );
}
