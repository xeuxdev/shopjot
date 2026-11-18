import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, Share, Smartphone } from 'lucide-react';
import { Button, Modal } from '../components/ui';

interface InstallPromptEvent extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function isStandalone() {
  return (
    window.matchMedia(
      '(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)',
    ).matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

// Keep install state in App so creating a store or changing pages never loses the prompt.
export function useAppInstall() {
  const [installed, setInstalled] = useState(isStandalone);
  const [installing, setInstalling] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);
  const prompt = useRef<InstallPromptEvent | null>(null);

  useEffect(() => {
    const displayMode = window.matchMedia(
      '(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)',
    );
    const beforeInstall = (event: Event) => {
      event.preventDefault();
      prompt.current = event as InstallPromptEvent;
    };
    const appInstalled = () => {
      prompt.current = null;
      setInstalled(true);
      setShowInstructions(false);
    };
    const modeChanged = () => setInstalled(isStandalone());
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', appInstalled);
    displayMode.addEventListener('change', modeChanged);
    return () => {
      window.removeEventListener('beforeinstallprompt', beforeInstall);
      window.removeEventListener('appinstalled', appInstalled);
      displayMode.removeEventListener('change', modeChanged);
    };
  }, []);

  async function install() {
    if (installing || installed) return;
    const deferredPrompt = prompt.current;
    if (!deferredPrompt) {
      setShowInstructions(true);
      return;
    }
    // A browser prompt can only be used once, including when it is dismissed.
    prompt.current = null;
    setInstalling(true);
    try {
      await deferredPrompt.prompt();
    } catch {
      setShowInstructions(true);
    } finally {
      setInstalling(false);
    }
  }

  return { installed, installing, install, showInstructions, setShowInstructions };
}

export function InstallAppButton({
  install,
  children = 'Install',
}: {
  install: ReturnType<typeof useAppInstall>;
  children?: ReactNode;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  if (install.installed) return null;
  return (
    <>
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        size="sm"
        className="install-button"
        aria-label="Install Shopjot"
        disabled={install.installing}
        onClick={() => void install.install()}
      >
        <Download size={16} aria-hidden="true" />
        {install.installing ? 'Installing…' : children}
      </Button>
      <Modal
        open={install.showInstructions}
        onOpenChange={install.setShowInstructions}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          buttonRef.current?.focus();
        }}
        title="Install Shopjot"
        description="Keep your store ledger on your home screen, ready to open even offline."
      >
        <div className="install-instructions">
          <section aria-labelledby="install-iphone-title">
            <h3 id="install-iphone-title">
              <Share size={18} aria-hidden="true" /> iPhone or iPad
            </h3>
            <ol>
              <li>Open this page in Safari.</li>
              <li>Tap Share (the square with an up arrow). It may be inside the More (…) menu.</li>
              <li>
                Choose <strong>Add to Home Screen</strong>.
              </li>
              <li>
                Keep <strong>Open as Web App</strong> on if shown, then tap <strong>Add</strong>.
              </li>
            </ol>
          </section>
          <section aria-labelledby="install-android-title">
            <h3 id="install-android-title">
              <Smartphone size={18} aria-hidden="true" /> Android
            </h3>
            <ol>
              <li>Open this page in Chrome.</li>
              <li>
                Tap the menu (⋮), then <strong>Install app</strong> or{' '}
                <strong>Add to Home screen</strong>.
              </li>
              <li>Follow the browser’s steps to add Shopjot.</li>
            </ol>
          </section>
          <p className="quiet-note">
            On a computer, look for the install icon in Chrome or Edge’s address bar.
          </p>
          <p className="quiet-note">
            Have records already? Back up in Settings & data before installing. If the installed app
            opens a fresh ledger, sign in to restore your store.
          </p>
        </div>
        <Button className="full-width" onClick={() => install.setShowInstructions(false)}>
          Got it
        </Button>
      </Modal>
    </>
  );
}
