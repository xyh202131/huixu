import { useId } from 'react';
import { ChevronRight } from 'lucide-react';

export function PageHead({ title, description, heading: Heading = 'h1', children }) {
  return <header className="page-head">
    <div><Heading>{title}</Heading>{description && <p>{description}</p>}</div>
    {children && <div className="actions">{children}</div>}
  </header>;
}

export function Panel({ title, action, children, className = '' }) {
  return <section className={'panel ' + className}>
    {(title || action) && <div className="panel-head"><h2>{title}</h2>{action}</div>}
    {children}
  </section>;
}

export function Badge({ tone = 'neutral', children }) {
  return <span className={'badge ' + tone}>{children}</span>;
}

export function IconTile({ icon: Icon, tone = 'blue' }) {
  return <span className={'icon-tile ' + tone}><Icon size={22} strokeWidth={1.8} aria-hidden="true" /></span>;
}

export function LinkButton({ onClick, children }) {
  return <button className="link-button" onClick={onClick}>{children}<ChevronRight size={16} aria-hidden="true" /></button>;
}

export function Empty({ children }) {
  return <p className="empty">{children}</p>;
}

export function Tabs({ items, value, onChange, label = '筛选' }) {
  const group = useId();
  const active = Math.max(0, items.indexOf(value));
  return <div className="tabs-scroll">
    <div className="tabs" role="radiogroup" aria-label={label} style={{ '--segments': items.length, '--segment-index': active }}>
      {items.map(item => <label key={item}>
        <input className="sr-only" type="radio" name={group} checked={item === value} onChange={() => onChange(item)} />
        <span>{item}</span>
      </label>)}
    </div>
  </div>;
}

export function Table({ headers, children }) {
  return <div className="table-scroll"><table><thead><tr>{headers.map(label => <th scope="col" key={label}>{label}</th>)}</tr></thead>
    <tbody>{children}</tbody></table></div>;
}
