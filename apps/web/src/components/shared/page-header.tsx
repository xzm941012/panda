import { useRouter } from '@tanstack/react-router'

export const PageHeader = ({
  title,
  subtitle,
  back,
  trailing,
}: {
  title: string
  subtitle?: string
  back?: boolean
  trailing?: React.ReactNode
}) => {
  const router = useRouter()

  return (
    <header className="page-header">
      {back && (
        <button
          type="button"
          className="page-header__back"
          onClick={() => router.history.back()}
          aria-label="返回"
        >
          ←
        </button>
      )}
      <div className="page-header__title">
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {trailing}
    </header>
  )
}
