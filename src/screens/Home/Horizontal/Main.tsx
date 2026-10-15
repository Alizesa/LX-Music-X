import { useEffect, useMemo, useState } from 'react'
import Recommend from '../Views/Recommend'
import Mine from '../Views/Mine'
import commonState, { type InitState as CommonState } from '@/store/common/state'


const Main = () => {
  const [id, setId] = useState(commonState.navActiveId)

  useEffect(() => {
    const handleUpdate = (id: CommonState['navActiveId']) => {
      requestAnimationFrame(() => {
        setId(id)
      })
    }
    global.state_event.on('navActiveIdUpdated', handleUpdate)
    return () => {
      global.state_event.off('navActiveIdUpdated', handleUpdate)
    }
  }, [])

  const component = useMemo(() => {
    switch (id) {
      case 'nav_mine': return <Mine />
      default: return <Recommend />
    }
  }, [id])

  return component
}


export default Main
