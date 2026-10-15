export {}

declare global {
  interface Window {
    foxwarmBoot?: { ready(): void; fail(error: unknown): void }
  }
}
