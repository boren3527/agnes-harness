import { fallbackT, type Translate } from './locales/index.js'
import { Button } from './ui/button.js'

export function SettingsImageModel({ t = fallbackT }: { t?: Translate }) {
  return (
    <section
      id="image-model-settings"
      className="config-card config-accounts-section"
      aria-labelledby="image-model-title"
    >
      <div className="config-accounts-heading">
        <div>
          <h3 id="image-model-title">{t('imageModel.title')}</h3>
          <p>{t('imageModel.intro')}</p>
        </div>
        <span id="image-model-status" role="status" aria-live="polite">
          {t('imageModel.unconfigured')}
        </span>
      </div>
      <div className="config-detail-grid">
        <label className="form-field">
          <span>{t('imageModel.model')}</span>
          <select id="image-model-model" defaultValue="qwen-image-2.1-pro">
            <option value="qwen-image-2.1-pro">qwen-image-2.1-pro</option>
            <option value="agnes-image-2.5-flash">agnes-image-2.5-flash</option>
          </select>
        </label>
        <label className="form-field">
          <span>{t('imageModel.size')}</span>
          <select id="image-model-size" defaultValue="1K">
            <option value="1K">1K · 1024 × 1024</option>
            <option value="2K">2K · 2048 × 2048</option>
          </select>
        </label>
        <label className="form-field form-field-wide">
          <span>API Key</span>
          <input
            id="image-model-key"
            type="password"
            autoComplete="new-password"
            aria-describedby="image-model-key-hint"
          />
        </label>
        <p id="image-model-key-hint" className="field-hint form-field-wide">
          {t('imageModel.keyHint')}
        </p>
        <label className="form-field form-field-wide image-model-toggle">
          <span>
            <input id="image-model-enabled" type="checkbox" /> {t('imageModel.enabled')}
          </span>
        </label>
      </div>
      <p id="image-model-endpoint" className="field-hint" />
      <p className="field-hint">{t('imageModel.workflowHint')}</p>
      <p className="field-hint">{t('imageModel.backgroundHint')}</p>
      <p className="field-hint">
        <a
          id="image-model-documentation"
          href="https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('imageModel.documentation')}
        </a>
      </p>
      <p id="image-model-message" role="status" aria-live="polite" />
      <div className="admin-toolbar-actions">
        <Button id="image-model-reload" htmlType="button" className="secondary-button compact">
          {t('imageModel.reload')}
        </Button>
        <Button id="image-model-save" htmlType="button" className="primary-button compact" disabled>
          {t('imageModel.save')}
        </Button>
      </div>
    </section>
  )
}
