export const StatChip = ({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) => (
  <div className="stat-chip">
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{note}</small>
  </div>
)
