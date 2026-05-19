import React, { useEffect, useRef } from 'react';
import './LoadingScreen.css';

interface Props {
  done: boolean;
}

export default function LoadingScreen({ done }: Props) {
  const barRef = useRef<HTMLDivElement>(null);

  // Animate bar: 0→80% in 1.5s, then when done=true jump to 100%
  useEffect(() => {
    if (!barRef.current) return;
    if (done) {
      barRef.current.style.transition = 'width 0.3s ease';
      barRef.current.style.width = '100%';
    } else {
      barRef.current.style.transition = 'width 1.5s cubic-bezier(0.4, 0, 0.2, 1)';
      barRef.current.style.width = '80%';
    }
  }, [done]);

  return (
    <div className={`loading-screen${done ? ' done' : ''}`}>
      <div className="ls-scene">
        <div className="ls-objects">
          <div className="ls-square" />
          <div className="ls-circle" />
          <div className="ls-triangle" />
        </div>
        <div className="ls-wizard">
          <div className="ls-body" />
          <div className="ls-right-arm">
            <div className="ls-right-hand" />
          </div>
          <div className="ls-left-arm">
            <div className="ls-left-hand" />
          </div>
          <div className="ls-head">
            <div className="ls-beard" />
            <div className="ls-face">
              <div className="ls-adds" />
            </div>
            <div className="ls-hat">
              <div className="ls-hat-of-the-hat" />
              <div className="ls-four-point-star first" />
              <div className="ls-four-point-star second" />
              <div className="ls-four-point-star third" />
            </div>
          </div>
        </div>
      </div>

      <div className="ls-progress">
        <div ref={barRef} className="ls-progress-bar" />
      </div>

      <div className="ls-noise" />
    </div>
  );
}
