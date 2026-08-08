import { render, screen } from '@testing-library/react'
import { LiveDashboard } from './LiveDashboard'
import { liveState } from '../test/fixture'

describe.each([360, 1024])('live layout at %ipx', (width) => {
  it('keeps the responsive semantic card contract', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    const { container } = render(<LiveDashboard state={liveState} now={1_800_000} />)
    expect(container.firstElementChild).toHaveClass('dashboard')
    expect(container.firstElementChild).toHaveAttribute('data-layout', 'responsive')
    expect(screen.getByRole('heading', { name: 'Primitive' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'A fierce cockatrice' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Recent' })).toBeInTheDocument()
  })
})
