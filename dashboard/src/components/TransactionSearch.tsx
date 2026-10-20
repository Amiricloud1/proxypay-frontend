import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useHistory, useLocation } from '@docusaurus/router';
import clsx from 'clsx';
import styles from './TransactionSearch.module.css';
import { useApiData } from '../context/ApiDataContext';
import { Operation } from '../types/openapi';
import { getOperationId, getOperationPath } from '../utils/operationUtils';

interface TransactionSearchProps {
  onSelect?: (operation: Operation | null) => void;
}

const SEARCH_PARAM = 'q';
const OPERATION_PARAM = 'op';
const DEPRECATED_PARAM = 'deprecated';

const TransactionSearch: React.FC<TransactionSearchProps> = ({ onSelect }) => {
  const { operations } = useApiData();
  const history = useHistory();
  const location = useLocation();

  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const searchQuery = params.get(SEARCH_PARAM) ?? '';
  const selectedOperationId = params.get(OPERATION_PARAM);
  const showDeprecated = params.get(DEPRECATED_PARAM) === 'true';

  const [inputValue, setInputValue] = useState(searchQuery);
  const [revealHidden, setRevealHidden] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    setInputValue(searchQuery);
  }, [searchQuery]);

  const updateParams = useCallback(
    (updates: Record<string, string | null>) => {
      const next = new URLSearchParams(location.search);
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === '') {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      });
      const query = next.toString();
      history.replace({ ...location, search: query ? `?${query}` : '' });
    },
    [history, location]
  );

  const matchesFilters = useCallback(
    (operation: Operation) => {
      if (!showDeprecated && operation.deprecated) {
        return false;
      }
      if (!searchQuery) {
        return true;
      }
      const haystack = [
        getOperationId(operation),
        getOperationPath(operation),
        operation.summary,
        operation.description,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(searchQuery.toLowerCase());
    },
    [searchQuery, showDeprecated]
  );

  const selectedOperation = useMemo(
    () => operations.find((op) => getOperationId(op) === selectedOperationId) ?? null,
    [operations, selectedOperationId]
  );

  const selectedIsHidden = selectedOperation !== null && !matchesFilters(selectedOperation);

  const visibleOperations = useMemo(() => {
    const filtered = operations.filter(matchesFilters);
    if (selectedOperation && selectedIsHidden && revealHidden) {
      return [selectedOperation, ...filtered];
    }
    return filtered;
  }, [operations, matchesFilters, selectedOperation, selectedIsHidden, revealHidden]);

  useEffect(() => {
    if (!selectedOperation || !listRef.current) {
      return;
    }
    const node = listRef.current.querySelector<HTMLElement>(
      `[data-operation-id="${CSS.escape(getOperationId(selectedOperation))}"]`
    );
    node?.scrollIntoView({ block: 'nearest' });
  }, [selectedOperation, visibleOperations]);

  const handleSelect = useCallback(
    (operation: Operation) => {
      const id = getOperationId(operation);
      const isSame = id === selectedOperationId;
      updateParams({ [OPERATION_PARAM]: isSame ? null : id });
      onSelect?.(isSame ? null : operation);
    },
    [selectedOperationId, updateParams, onSelect]
  );

  const handleSearchChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value;
      setInputValue(value);
      setRevealHidden(false);
      updateParams({ [SEARCH_PARAM]: value || null });
    },
    [updateParams]
  );

  const handleDeprecatedToggle = useCallback(() => {
    setRevealHidden(false);
    updateParams({ [DEPRECATED_PARAM]: showDeprecated ? null : 'true' });
  }, [showDeprecated, updateParams]);

  const handleRevealSelected = useCallback(() => {
    setRevealHidden(true);
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.controls}>
        <input
          type="search"
          className={styles.searchInput}
          placeholder="Search endpoints..."
          value={inputValue}
          onChange={handleSearchChange}
          aria-label="Search endpoints"
        />
        <label className={styles.deprecatedToggle}>
          <input type="checkbox" checked={showDeprecated} onChange={handleDeprecatedToggle} />
          Show deprecated
        </label>
      </div>

      {selectedIsHidden && !revealHidden && (
        <div className={styles.hiddenNotice} role="status">
          <span>
            The selected endpoint <strong>{getOperationId(selectedOperation!)}</strong> is hidden by
            the active filters.
          </span>
          <button type="button" className={styles.revealButton} onClick={handleRevealSelected}>
            Reveal selected endpoint
          </button>
        </div>
      )}

      {visibleOperations.length === 0 ? (
        <p className={styles.emptyState}>No endpoints match the current filters.</p>
      ) : (
        <ul className={styles.list} ref={listRef}>
          {visibleOperations.map((operation) => {
            const id = getOperationId(operation);
            const isSelected = id === selectedOperationId;
            return (
              <li key={id}>
                <button
                  type="button"
                  data-operation-id={id}
                  className={clsx(styles.item, isSelected && styles.itemSelected)}
                  aria-current={isSelected ? 'true' : undefined}
                  onClick={() => handleSelect(operation)}
                >
                  <span className={styles.method}>{operation.method.toUpperCase()}</span>
                  <span className={styles.path}>{getOperationPath(operation)}</span>
                  {operation.summary && <span className={styles.summary}>{operation.summary}</span>}
                  {operation.deprecated && <span className={styles.deprecatedBadge}>Deprecated</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default TransactionSearch;
