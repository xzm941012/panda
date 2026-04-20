import { memo, useEffect, useMemo, useState } from 'react'
import type { SessionInteractionRequest } from '@panda/protocol'

type SessionInteractionStripProps = {
  requests: SessionInteractionRequest[]
  hasStripBelow: boolean
  pendingRequestId: string | null
  onRespond: (input: {
    requestId: string
    optionId?: string | null
    text?: string | null
    answers?: Record<string, string>
  }) => void
}

const IconChevronLeft = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 18-6-6 6-6" />
  </svg>
)

const IconChevronRight = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 18 6-6-6-6" />
  </svg>
)

const IconInfo = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 10.4v4.2" />
    <path d="M12 7.9h.01" />
  </svg>
)

const getQuestionAnswer = (
  answers: Record<string, string>,
  questionId: string,
) => answers[questionId]?.trim() ?? ''

const isDesktopViewport = () =>
  typeof window !== 'undefined' && !window.matchMedia('(max-width: 768px)').matches

export const SessionInteractionStrip = memo(function SessionInteractionStrip({
  requests,
  hasStripBelow,
  pendingRequestId,
  onRespond,
}: SessionInteractionStripProps) {
  const currentRequest = requests[0] ?? null
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null)
  const [freeformText, setFreeformText] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [questionIndex, setQuestionIndex] = useState(0)
  const [customQuestionId, setCustomQuestionId] = useState<string | null>(null)
  const [activeTooltipId, setActiveTooltipId] = useState<string | null>(null)

  useEffect(() => {
    setSelectedOptionId(null)
    setFreeformText('')
    setAnswers({})
    setQuestionIndex(0)
    setCustomQuestionId(null)
    setActiveTooltipId(null)
  }, [currentRequest?.id])

  const isPending = currentRequest ? pendingRequestId === currentRequest.id : false
  const isUserInputFlow = currentRequest?.kind === 'user_input'
  const currentQuestion =
    isUserInputFlow && currentRequest.questions.length > 0
      ? currentRequest.questions[
          Math.max(0, Math.min(questionIndex, currentRequest.questions.length - 1))
        ] ?? null
      : null

  const currentQuestionAnswer = currentQuestion
    ? getQuestionAnswer(answers, currentQuestion.id)
    : ''
  const currentAnswerMatchesOption = currentQuestion
    ? currentQuestion.options.some((option) => option.label === currentQuestionAnswer)
    : false
  const isCustomAnswerActive = Boolean(
    currentQuestion &&
      currentQuestionAnswer &&
      (!currentAnswerMatchesOption || customQuestionId === currentQuestion.id),
  )

  useEffect(() => {
    if (!currentQuestion) {
      setCustomQuestionId(null)
      return
    }

    if (currentAnswerMatchesOption) {
      setCustomQuestionId(null)
      return
    }

    if (currentQuestionAnswer) {
      setCustomQuestionId(currentQuestion.id)
    }
  }, [currentAnswerMatchesOption, currentQuestion, currentQuestionAnswer])

  const canSubmit = useMemo(() => {
    if (!currentRequest || isPending) {
      return false
    }

    if (currentRequest.kind === 'user_input') {
      if (!currentQuestion) {
        return false
      }

      return Boolean(currentQuestionAnswer)
    }

    if (selectedOptionId) {
      return true
    }

    if (currentRequest.allow_freeform) {
      return Boolean(freeformText.trim())
    }

    return false
  }, [
    currentQuestion,
    currentQuestionAnswer,
    currentRequest,
    freeformText,
    isPending,
    selectedOptionId,
  ])

  if (!currentRequest) {
    return null
  }

  const optionCount = currentRequest.questions.reduce(
    (count, question) => count + question.options.length,
    currentRequest.options.length,
  )

  const submitCurrentRequest = (override?: {
    optionId?: string | null
    text?: string | null
    answers?: Record<string, string>
  }) => {
    if (isPending) {
      return
    }

    onRespond({
      requestId: currentRequest.id,
      optionId: override?.optionId ?? selectedOptionId,
      text: override?.text ?? freeformText,
      answers: override?.answers ?? answers,
    })
  }

  const submitOrAdvanceQuestion = () => {
    if (!currentRequest || currentRequest.kind !== 'user_input' || !currentQuestion) {
      return
    }

    if (questionIndex < currentRequest.questions.length - 1) {
      setQuestionIndex((current) =>
        Math.min(current + 1, currentRequest.questions.length - 1),
      )
      return
    }

    submitCurrentRequest()
  }

  const skipCurrentQuestion = () => {
    if (!currentRequest || currentRequest.kind !== 'user_input' || !currentQuestion) {
      return
    }

    const nextAnswers = {
      ...answers,
      [currentQuestion.id]: '忽略',
    }
    setAnswers(nextAnswers)
    setCustomQuestionId(null)

    if (questionIndex < currentRequest.questions.length - 1) {
      setQuestionIndex((current) =>
        Math.min(current + 1, currentRequest.questions.length - 1),
      )
      return
    }

    submitCurrentRequest({ answers: nextAnswers })
  }

  const handleOptionSelect = (optionLabel: string) => {
    if (!currentRequest || currentRequest.kind !== 'user_input' || !currentQuestion || isPending) {
      return
    }

    if (currentQuestionAnswer === optionLabel) {
      submitOrAdvanceQuestion()
      return
    }

    setAnswers((current) => ({
      ...current,
      [currentQuestion.id]: optionLabel,
    }))
    setCustomQuestionId(null)
  }

  return (
    <section
      className={`session-interaction-strip ${hasStripBelow ? 'has-strip-below' : ''} ${
        isUserInputFlow ? 'is-user-input-flow' : ''
      }`}
    >
      {currentRequest.kind === 'user_input' && currentQuestion ? (
        <>
          <div className="session-interaction-flow__header">
            <div className="session-interaction-flow__prompt">
              {currentQuestion.question}
            </div>

            <div className="session-interaction-flow__progress">
              <button
                type="button"
                className="session-interaction-flow__nav"
                aria-label="上一题"
                disabled={questionIndex === 0 || isPending}
                onClick={() => setQuestionIndex((current) => Math.max(0, current - 1))}
              >
                <IconChevronLeft />
              </button>
              <span className="session-interaction-flow__counter">
                {questionIndex + 1} / {currentRequest.questions.length}
              </span>
              <button
                type="button"
                className="session-interaction-flow__nav"
                aria-label={questionIndex === currentRequest.questions.length - 1 ? '提交回复' : '下一题'}
                disabled={isPending || !canSubmit}
                onClick={submitOrAdvanceQuestion}
              >
                <IconChevronRight />
              </button>
            </div>
          </div>

          <div className="session-interaction-flow__body">
            <div className="session-interaction-flow__list">
              {currentQuestion.options.map((option, index) => (
                <div
                  key={option.id}
                  className={`session-interaction-flow__item is-${option.emphasis} ${
                    currentQuestionAnswer === option.label ? 'is-active' : ''
                  }`}
                  role="button"
                  tabIndex={isPending ? -1 : 0}
                  aria-pressed={currentQuestionAnswer === option.label}
                  onClick={() => handleOptionSelect(option.label)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') {
                      return
                    }

                    if (!isDesktopViewport()) {
                      return
                    }

                    event.preventDefault()
                    handleOptionSelect(option.label)
                  }}
                >
                  <span className="session-interaction-flow__item-index">
                    {index + 1}.
                  </span>
                  <span className="session-interaction-flow__item-choice">
                    <span className="session-interaction-flow__item-label">
                      {option.label}
                    </span>
                    {option.description ? (
                      <span className="session-interaction-flow__tooltip-wrap">
                        <button
                          type="button"
                          className="session-interaction-flow__tooltip-trigger"
                          aria-label={`查看 ${option.label} 的说明`}
                          aria-expanded={activeTooltipId === option.id}
                          onMouseEnter={() => setActiveTooltipId(option.id)}
                          onMouseLeave={() =>
                            setActiveTooltipId((current) =>
                              current === option.id ? null : current,
                            )
                          }
                          onBlur={() =>
                            setActiveTooltipId((current) =>
                              current === option.id ? null : current,
                            )
                          }
                          onClick={(event) => {
                            event.stopPropagation()
                            setActiveTooltipId((current) =>
                              current === option.id ? null : option.id,
                            )
                          }}
                        >
                          <IconInfo />
                        </button>
                        <div
                          className={`session-interaction-flow__tooltip ${
                            activeTooltipId === option.id ? 'is-visible' : ''
                          }`}
                          role="tooltip"
                        >
                          {option.description}
                        </div>
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}

              <div
                className={`session-interaction-flow__item is-custom ${
                  isCustomAnswerActive ? 'is-active' : ''
                }`}
              >
                <div className="session-interaction-flow__custom-input-wrap">
                  <input
                    type="text"
                    className="session-interaction-flow__custom-input"
                    value={currentAnswerMatchesOption ? '' : currentQuestionAnswer}
                    disabled={isPending}
                    placeholder={
                      currentQuestion.is_secret ? '输入敏感信息' : '否，请告知如何调整'
                    }
                    onFocus={() => {
                      setCustomQuestionId(currentQuestion.id)
                      if (currentAnswerMatchesOption) {
                        setAnswers((current) => ({
                          ...current,
                          [currentQuestion.id]: '',
                        }))
                      }
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'Enter' &&
                        canSubmit &&
                        !isPending &&
                        isDesktopViewport()
                      ) {
                        event.preventDefault()
                        submitOrAdvanceQuestion()
                      }
                    }}
                    onChange={(event) => {
                      setCustomQuestionId(currentQuestion.id)
                      setAnswers((current) => ({
                        ...current,
                        [currentQuestion.id]: event.target.value,
                      }))
                    }}
                  />
                  <div className="session-interaction-flow__inline-actions">
                    <button
                      type="button"
                      className="session-interaction-flow__ghost"
                      disabled={isPending}
                      onClick={skipCurrentQuestion}
                    >
                      忽略
                    </button>
                    <button
                      type="button"
                      className="session-interaction-flow__primary"
                      disabled={!canSubmit}
                      onClick={submitOrAdvanceQuestion}
                    >
                      {isPending
                        ? '提交中...'
                        : questionIndex === currentRequest.questions.length - 1
                          ? (currentRequest.submit_label ?? '提交回复')
                          : '继续'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="session-interaction-strip__header">
            <span className="session-interaction-strip__icon" aria-hidden="true">
              <IconInfo />
            </span>
            <div className="session-interaction-strip__copy">
              <div className="session-interaction-strip__title">
                {currentRequest.title}
                {requests.length > 1 ? (
                  <span className="session-interaction-strip__count">
                    还有 {requests.length - 1} 个待处理
                  </span>
                ) : null}
              </div>
              {currentRequest.description ? (
                <div className="session-interaction-strip__description">
                  {currentRequest.description}
                </div>
              ) : null}
            </div>
          </div>

          {currentRequest.options.length > 0 ? (
            <div className="session-interaction-strip__options">
              {currentRequest.options.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={`session-interaction-option is-${option.emphasis} ${
                    selectedOptionId === option.id ? 'is-active' : ''
                  }`}
                  disabled={isPending}
                  onClick={() => {
                    setSelectedOptionId(option.id)
                    if (!currentRequest.allow_freeform && optionCount <= 3) {
                      submitCurrentRequest({ optionId: option.id })
                    }
                  }}
                >
                  <span className="session-interaction-option__label">{option.label}</span>
                  {option.description ? (
                    <span className="session-interaction-option__description">
                      {option.description}
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}

          {currentRequest.allow_freeform ? (
            <label className="session-interaction-strip__freeform">
              <span className="session-interaction-strip__freeform-label">
                自定义回复
              </span>
              <textarea
                value={freeformText}
                disabled={isPending}
                placeholder={currentRequest.freeform_placeholder ?? '输入回复内容'}
                onChange={(event) => setFreeformText(event.target.value)}
              />
            </label>
          ) : null}

          {(currentRequest.allow_freeform || currentRequest.options.length > 3) ? (
            <div className="session-interaction-strip__footer">
              <button
                type="button"
                className="session-interaction-strip__submit"
                disabled={!canSubmit}
                onClick={() => submitCurrentRequest()}
              >
                {isPending
                  ? '提交中...'
                  : currentRequest.submit_label ?? '继续'}
              </button>
            </div>
          ) : null}
        </>
      )}
    </section>
  )
})
