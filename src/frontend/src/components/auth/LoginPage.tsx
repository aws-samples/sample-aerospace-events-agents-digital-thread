import { useState } from 'react';
import { signIn, confirmSignIn } from 'aws-amplify/auth';
import { Shield } from 'lucide-react';

type LoginPageProps = {
  onSignedIn: () => void;
};

export function LoginPage({ onSignedIn }: LoginPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [needsNewPassword, setNeedsNewPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await signIn({ username: email, password });

      if (result.nextStep?.signInStep === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') {
        setNeedsNewPassword(true);
      } else if (result.isSignedIn) {
        onSignedIn();
      }
    } catch (err: any) {
      console.error('[Auth] signIn error', { name: err.name, message: err.message, code: err.code, err });
      setError(err.message ?? 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleNewPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const result = await confirmSignIn({ challengeResponse: newPassword });
      if (result.isSignedIn) {
        onSignedIn();
      }
    } catch (err: any) {
      setError(err.message ?? 'Password change failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-surface-app flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 mb-3">
            <Shield size={20} className="text-accent" />
            <span className="text-lg font-bold tracking-widest text-text-primary uppercase">
              ARES-1
            </span>
          </div>
          <p className="text-sm text-text-tertiary">
            Aerospace Digital Thread Platform
          </p>
        </div>

        {/* Card */}
        <div className="bg-surface-primary border border-border rounded-xl shadow-[0_1px_3px_0_rgb(0_0_0/0.08)] p-6">
          <h2 className="text-sm font-bold text-text-primary uppercase tracking-wide mb-4">
            {needsNewPassword ? 'Set New Password' : 'Sign In'}
          </h2>

          {error && (
            <div className="mb-4 px-3 py-2 rounded-lg bg-status-error-subtle text-status-error-text text-xs font-mono">
              {error}
            </div>
          )}

          {needsNewPassword ? (
            <form onSubmit={handleNewPassword} className="space-y-3">
              <div>
                <label className="block text-[10px] font-mono font-semibold text-text-muted uppercase tracking-[0.1em] mb-1">
                  New Password
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full bg-surface-primary border border-border-strong rounded-lg px-3 py-2
                    text-[13px] text-text-primary placeholder-text-muted
                    focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
                  placeholder="Choose a new password"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full px-4 py-2 text-[12px] font-bold text-white bg-accent rounded-lg
                  hover:bg-accent-hover transition-colors uppercase tracking-wide disabled:opacity-50"
              >
                {loading ? 'Setting...' : 'Set Password'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSignIn} className="space-y-3">
              <div>
                <label className="block text-[10px] font-mono font-semibold text-text-muted uppercase tracking-[0.1em] mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-surface-primary border border-border-strong rounded-lg px-3 py-2
                    text-[13px] text-text-primary placeholder-text-muted
                    focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
                  placeholder="demo@ares1.test"
                  required
                />
              </div>
              <div>
                <label className="block text-[10px] font-mono font-semibold text-text-muted uppercase tracking-[0.1em] mb-1">
                  Password
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-surface-primary border border-border-strong rounded-lg px-3 py-2
                    text-[13px] text-text-primary placeholder-text-muted
                    focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent transition-colors"
                  placeholder="Password"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={loading}
                className="w-full px-4 py-2 text-[12px] font-bold text-white bg-accent rounded-lg
                  hover:bg-accent-hover transition-colors uppercase tracking-wide disabled:opacity-50"
              >
                {loading ? 'Signing in...' : 'Sign In'}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-[11px] text-text-muted mt-4 font-mono">
          S/N 0047 &middot; Wing Box Assembly &middot; eu-west-1
        </p>
      </div>
    </div>
  );
}
