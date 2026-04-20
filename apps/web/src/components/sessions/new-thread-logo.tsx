import wordmarkSvg from '../../assets/new-thread-logo-wordmark.svg?raw'

export const NewThreadLogo = () => (
  <span
    aria-hidden="true"
    className="new-thread-hero__logo"
    dangerouslySetInnerHTML={{ __html: wordmarkSvg }}
  />
)
