import { describe, it, expect, vi } from 'vitest'
import {
  createGeminiWorkflowDigestLLM,
  parseWorkflowDigestPlan,
  type WorkflowDigestInput,
  type WorkflowDigestModelCall,
} from '../workflow-digest-llm.js'

type ModelCallRequest = Parameters<WorkflowDigestModelCall>[0]

const WF_ID = '00000000-0000-4000-8000-000000000001'

const VALID_PLAN = JSON.stringify({
  candidates: [
    {
      slug: 'weekly-metrics-digest',
      name: 'Weekly metrics digest',
      description: 'How to assemble the weekly metrics report',
      content: '# Weekly metrics digest\n\n## When to use\n…',
      sourceWorkflowIds: [WF_ID],
    },
  ],
})

function input(): WorkflowDigestInput {
  return {
    workspaceId: 'ws-1',
    userId: 'user-1',
    workflows: [
      {
        id: WF_ID,
        name: 'Metrics reminder',
        description: null,
        triggerKind: 'manual',
        runCount: 1,
        idleDays: 45,
        steps: [{ type: 'assistant_call', summary: 'Assemble the weekly metrics report' }],
      },
    ],
    existingSkills: [{ slug: 'existing', name: 'Existing', description: 'already here' }],
  }
}

describe('[COMP:workers/workflow-digest-llm] Workflow digest LLM port', () => {
  describe('parseWorkflowDigestPlan', () => {
    it('parses a bare JSON plan', () => {
      const result = parseWorkflowDigestPlan(VALID_PLAN)
      expect(result.plan?.candidates).toHaveLength(1)
      expect(result.plan?.candidates[0].slug).toBe('weekly-metrics-digest')
    })

    it('strips code fences and leading prose', () => {
      const result = parseWorkflowDigestPlan('```json\n' + VALID_PLAN + '\n```')
      expect(result.plan?.candidates).toHaveLength(1)
    })

    it('rejects a bad slug shape with a structured error', () => {
      const bad = JSON.stringify({
        candidates: [
          {
            slug: 'Not A Slug',
            name: 'x',
            description: 'y',
            content: 'z',
            sourceWorkflowIds: [WF_ID],
          },
        ],
      })
      const result = parseWorkflowDigestPlan(bad)
      expect(result.plan).toBeUndefined()
      expect(result.error).toContain('slug')
    })

    it('rejects non-JSON output', () => {
      expect(parseWorkflowDigestPlan('nothing to digest here').error).toBeTruthy()
    })
  })

  describe('createGeminiWorkflowDigestLLM', () => {
    it('returns the first valid plan without a retry', async () => {
      const requests: ModelCallRequest[] = []
      const call = vi.fn(async (req: ModelCallRequest) => {
        requests.push(req)
        return VALID_PLAN
      })
      const llm = createGeminiWorkflowDigestLLM(call)
      const plan = await llm.plan(input())
      expect(plan.candidates).toHaveLength(1)
      expect(call).toHaveBeenCalledTimes(1)
      // Attribution rides through to the model-call seam.
      expect(requests[0]?.attribution).toEqual({ workspaceId: 'ws-1', userId: 'user-1' })
      // The prompt names the batch and the existing skills.
      expect(requests[0]?.prompt).toContain(WF_ID)
      expect(requests[0]?.prompt).toContain('existing')
    })

    it('re-prompts once with the rejection reason, then degrades to the empty plan', async () => {
      const requests: ModelCallRequest[] = []
      const outputs = ['not json at all', 'still not json']
      const call = vi.fn(async (req: ModelCallRequest) => {
        requests.push(req)
        return outputs[requests.length - 1] ?? ''
      })
      const llm = createGeminiWorkflowDigestLLM(call)
      const plan = await llm.plan(input())
      expect(plan).toEqual({ candidates: [] })
      expect(call).toHaveBeenCalledTimes(2)
      expect(requests[1]?.prompt).toContain('rejected')
    })

    it('recovers when the corrective retry returns a valid plan', async () => {
      let calls = 0
      const call = vi.fn(async (_req: ModelCallRequest) => {
        calls += 1
        return calls === 1 ? 'garbage' : VALID_PLAN
      })
      const llm = createGeminiWorkflowDigestLLM(call)
      const plan = await llm.plan(input())
      expect(plan.candidates).toHaveLength(1)
    })
  })
})
