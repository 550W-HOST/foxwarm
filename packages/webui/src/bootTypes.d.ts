export {}

declare global {
  interface Window {
    foxwarmBoot?: { ready(): void; fail(error: unknown): void; update(build: string | null): void }
  }
}
